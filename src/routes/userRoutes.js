const express = require("express");
const axios = require("axios");
const { z } = require("zod");
const env = require("../config/env");
const { requireAuth, requireRole } = require("../middleware/requireAuth");
const { Doctor } = require("../models/Doctor");
const { Patient } = require("../models/Patient");
const { buildAvailabilityDaysFromSpec } = require("../utils/availability");
const { SPECIALIZATIONS } = require("../constants/specializations");

const router = express.Router();

async function fetchAppointmentsForDoctor(doctorId) {
  try {
    const { data } = await axios.get(`${env.APPOINTMENT_SERVICE_URL}/internal/doctors/${encodeURIComponent(doctorId)}/appointments`, {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
    });
    return data.appointments || [];
  } catch {
    return [];
  }
}

async function fetchAppointmentsForPatient(patientId) {
  try {
    const { data } = await axios.get(`${env.APPOINTMENT_SERVICE_URL}/internal/patients/${encodeURIComponent(patientId)}/appointments`, {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
    });
    return data.appointments || [];
  } catch {
    return [];
  }
}

async function fetchAppointmentStats() {
  try {
    const { data } = await axios.get(`${env.APPOINTMENT_SERVICE_URL}/internal/stats`, {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
    });
    return data;
  } catch {
    return {
      totalAppointments: 0,
      byStatus: { PENDING: 0, ACCEPTED: 0, REJECTED: 0, COMPLETED: 0, CANCELLED: 0 },
      activeDoctors: 0
    };
  }
}

router.get("/users/me", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === "DOCTOR") {
      const doctor = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
      return res.json({ profile: doctor ? { ...doctor.toObject(), id: doctor.authUserId } : null });
    }
    if (req.user.role === "PATIENT") {
      const patient = await Patient.findOne({ authUserId: req.user.id });
      return res.json({ profile: patient ? { ...patient.toObject(), id: patient.authUserId } : null });
    }
    return res.json({ profile: { id: req.user.id, email: req.user.email, role: req.user.role } });
  } catch (err) {
    return next(err);
  }
});

const createDoctorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  specialization: z.enum(SPECIALIZATIONS),
  experienceYears: z.coerce.number().int().min(0).optional().default(0),
  phone: z.string().optional().default(""),
  availability: z
    .array(
      z.object({
        date: z.string().min(10),
        slots: z.array(z.object({ time: z.string().min(3) })).min(1)
      })
    )
    .optional()
});

async function createDoctorHandler(req, res, next) {
  try {
    const { name, email, password, specialization, experienceYears, phone, availability } = createDoctorSchema.parse(req.body);

    let availabilityDays = [];
    try {
      availabilityDays = buildAvailabilityDaysFromSpec(availability || []);
    } catch {
      return res.status(400).json({ error: "INVALID_AVAILABILITY" });
    }

    const resp = await axios.post(
      `${env.AUTH_SERVICE_URL}/internal/users`,
      { email, password, role: "DOCTOR", name, phone },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    const authUserId = resp.data.user.id;

    const doctor = await Doctor.findOneAndUpdate(
      { authUserId },
      { authUserId, email, name, specialization, experienceYears, phone: phone || "", availability: availabilityDays },
      { upsert: true, new: true }
    );

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/notify`,
      {
        userId: authUserId,
        type: "PROFILE_UPDATE",
        message: "Your doctor account has been created. Welcome aboard."
      },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/activity`,
      { actorUserId: req.user.id, action: "DOCTOR_CREATED", details: { doctorId: authUserId, email, specialization } },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    return res.status(201).json({
      doctor: {
        id: doctor.authUserId,
        name: doctor.name,
        email: doctor.email,
        specialization: doctor.specialization,
        experienceYears: doctor.experienceYears,
        phone: doctor.phone,
        availability: doctor.availability
      }
    });
  } catch (err) {
    if (err.name === "ZodError") {
      const isSpecError = err.issues.some((i) => i.path.includes("specialization"));
      if (isSpecError) {
        return res.status(400).json({ error: "Specialization is required and must be valid" });
      }
      return res.status(400).json({ error: err.issues[0]?.message || "Invalid payload" });
    }
    return next(err);
  }
}

router.post("/admin/doctors", requireAuth, requireRole("ADMIN"), createDoctorHandler);
router.post("/admin/doctor", requireAuth, requireRole("ADMIN"), createDoctorHandler);

router.delete("/admin/doctor/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const doctorId = req.params.id;
    const doctor = await Doctor.findOne({ authUserId: doctorId, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });

    const authResp = await axios.get(`${env.AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(doctorId)}`, {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY },
      validateStatus: () => true
    });
    if (authResp.status >= 400) return res.status(400).json({ error: "AUTH_USER_NOT_FOUND" });
    if (authResp.data?.user?.role !== "DOCTOR") return res.status(400).json({ error: "NOT_A_DOCTOR" });

    const { data } = await axios.post(
      `${env.APPOINTMENT_SERVICE_URL}/internal/appointments/cancel-by-doctor/${encodeURIComponent(doctorId)}`,
      {},
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    await axios.delete(`${env.AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(doctorId)}`, {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
    });

    await Doctor.deleteOne({ authUserId: doctorId });

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/activity`,
      { actorUserId: req.user.id, action: "DOCTOR_DELETED", details: { doctorId, cancelled: data?.cancelled?.length || 0 } },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    return res.json({ ok: true, cancelledAppointments: data?.cancelled || [] });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/doctors", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const doctors = await Doctor.find({ deletedAt: null }).sort({ createdAt: -1 });
    res.json({
      doctors: doctors.map((d) => ({
        id: d.authUserId,
        name: d.name,
        email: d.email,
        phone: d.phone,
        specialization: d.specialization,
        experienceYears: d.experienceYears,
        availability: d.availability,
        createdAt: d.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/patients", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const patients = await Patient.find().sort({ createdAt: -1 });
    res.json({
      patients: patients.map((p) => ({
        id: p.authUserId,
        name: p.name,
        email: p.email,
        phone: p.phone,
        createdAt: p.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/doctors/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const doctor = await Doctor.findOne({ authUserId: req.params.id, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });
    const appointments = await fetchAppointmentsForDoctor(doctor.authUserId);
    const prescriptions = appointments
      .filter((a) => a.prescription && Array.isArray(a.prescription.medicines) && a.prescription.medicines.length > 0)
      .map((a) => ({
        appointmentId: a._id,
        startTime: a.startTime,
        status: a.status,
        prescription: a.prescription
      }));
    res.json({
      doctor: {
        id: doctor.authUserId,
        name: doctor.name,
        email: doctor.email,
        phone: doctor.phone,
        specialization: doctor.specialization,
        experienceYears: doctor.experienceYears,
        availability: doctor.availability,
        createdAt: doctor.createdAt
      },
      appointments,
      prescriptions
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/patients/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const patient = await Patient.findOne({ authUserId: req.params.id });
    if (!patient) return res.status(404).json({ error: "NOT_FOUND" });
    const appointments = await fetchAppointmentsForPatient(patient.authUserId);
    const prescriptions = appointments
      .filter((a) => a.prescription && Array.isArray(a.prescription.medicines) && a.prescription.medicines.length > 0)
      .map((a) => ({
        appointmentId: a._id,
        startTime: a.startTime,
        status: a.status,
        prescription: a.prescription
      }));
    res.json({
      patient: {
        id: patient.authUserId,
        name: patient.name,
        email: patient.email,
        phone: patient.phone,
        createdAt: patient.createdAt
      },
      appointments,
      prescriptions
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/analytics", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const [doctorCount, patientCount, apptStats] = await Promise.all([Doctor.countDocuments({ deletedAt: null }), Patient.countDocuments(), fetchAppointmentStats()]);
    res.json({
      totalAppointments: apptStats.totalAppointments,
      appointmentsByStatus: apptStats.byStatus,
      activeDoctors: apptStats.activeDoctors,
      doctorProfiles: doctorCount,
      patientProfiles: patientCount
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { userRoutes: router };

const express = require("express");
const { z } = require("zod");
const { requireInternal } = require("../middleware/internalAuth");
const { Doctor } = require("../models/Doctor");
const { Patient } = require("../models/Patient");
const { lockSlotAtomic, releaseSlotAtomic, setSlotAppointmentId } = require("../utils/availability");

const router = express.Router();
router.use(requireInternal);

const syncDoctorSchema = z.object({
  authUserId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  specialization: z.string().min(1),
  experienceYears: z.coerce.number().int().min(0).optional(),
  phone: z.string().optional()
});

router.post("/doctors/sync", async (req, res, next) => {
  try {
    const body = syncDoctorSchema.parse(req.body);
    const { authUserId, email, name, specialization } = body;
    const patch = { authUserId, email, name, specialization };
    if (body.experienceYears !== undefined) patch.experienceYears = body.experienceYears;
    if (body.phone !== undefined) patch.phone = body.phone;
    const doctor = await Doctor.findOneAndUpdate({ authUserId }, patch, { upsert: true, new: true });
    res.json({ doctor: { id: doctor.authUserId } });
  } catch (err) {
    next(err);
  }
});

const syncPatientSchema = z.object({
  authUserId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  phone: z.string().optional()
});

router.post("/patients/sync", async (req, res, next) => {
  try {
    const body = syncPatientSchema.parse(req.body);
    const { authUserId, email, name } = body;
    const patch = { authUserId, email, name };
    if (body.phone !== undefined) patch.phone = body.phone;
    const patient = await Patient.findOneAndUpdate({ authUserId }, patch, { upsert: true, new: true });
    res.json({ patient: { id: patient.authUserId } });
  } catch (err) {
    next(err);
  }
});

const lockBody = z.object({
  doctorId: z.string().min(1),
  slotId: z.string().min(1),
  patientId: z.string().min(1)
});

router.post("/slots/lock", async (req, res, next) => {
  try {
    const body = lockBody.parse(req.body);
    const result = await lockSlotAtomic(body);
    if (!result.ok) return res.status(409).json({ error: result.error || "SLOT_UNAVAILABLE" });
    return res.json({ startTime: result.startTime, endTime: result.endTime });
  } catch (err) {
    next(err);
  }
});

const releaseBody = z.object({
  doctorId: z.string().min(1),
  slotId: z.string().min(1),
  patientId: z.string().min(1).optional()
});

router.post("/slots/release", async (req, res, next) => {
  try {
    const body = releaseBody.parse(req.body);
    const result = await releaseSlotAtomic(body);
    if (!result.ok) return res.status(409).json({ error: result.error || "SLOT_RELEASE_FAILED" });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const attachBody = z.object({
  doctorId: z.string().min(1),
  slotId: z.string().min(1),
  appointmentId: z.string().min(1)
});

router.post("/slots/set-appointment", async (req, res, next) => {
  try {
    const body = attachBody.parse(req.body);
    const result = await setSlotAppointmentId(body);
    if (!result.ok) return res.status(400).json({ error: "SLOT_UPDATE_FAILED" });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { internalRoutes: router };

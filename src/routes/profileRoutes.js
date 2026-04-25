const express = require("express");
const axios = require("axios");
const { z } = require("zod");
const env = require("../config/env");
const { requireAuth } = require("../middleware/requireAuth");
const { Doctor } = require("../models/Doctor");
const { Patient } = require("../models/Patient");
const { SPECIALIZATIONS } = require("../constants/specializations");

const router = express.Router();

async function fetchAuthUser(userId) {
  const { data } = await axios.get(`${env.AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(userId)}`, {
    headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
  });
  return data.user;
}

router.get("/profile/me", requireAuth, async (req, res, next) => {
  try {
    const authUser = await fetchAuthUser(req.user.id);
    let profile = null;
    if (req.user.role === "DOCTOR") {
      const doctor = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
      profile = doctor ? { ...doctor.toObject(), id: doctor.authUserId } : null;
    } else if (req.user.role === "PATIENT") {
      const patient = await Patient.findOne({ authUserId: req.user.id });
      profile = patient ? { ...patient.toObject(), id: patient.authUserId } : null;
    }
    return res.json({ auth: authUser, profile });
  } catch (err) {
    return next(err);
  }
});

const updateProfileSchema = z.object({
  phone: z.string().optional(),
  specialization: z.enum(SPECIALIZATIONS).optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).optional()
});

router.put("/profile/update", requireAuth, async (req, res, next) => {
  try {
    const body = updateProfileSchema.parse(req.body);
    const targetId = req.user.id;

    const authUser = await fetchAuthUser(targetId);
    const selfEdit = true;

    // name/email/medicalHistory/experienceYears/admin override are removed by strict scope.
    if (req.body?.name !== undefined || req.body?.email !== undefined) {
      return res.status(400).json({ error: "IMMUTABLE_FIELD" });
    }
    if (req.body?.userId !== undefined) {
      return res.status(400).json({ error: "ADMIN_OVERRIDE_REMOVED" });
    }
    if (req.body?.medicalHistory !== undefined) {
      return res.status(400).json({ error: "FIELD_REMOVED" });
    }
    if (req.body?.experienceYears !== undefined) {
      return res.status(400).json({ error: "FIELD_REMOVED" });
    }

    const needsPasswordProof = Boolean(body.newPassword);
    if (needsPasswordProof) {
      if (!body.currentPassword) return res.status(400).json({ error: "CURRENT_PASSWORD_REQUIRED" });
      try {
        await axios.post(
          `${env.AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(targetId)}/verify-password`,
          { password: body.currentPassword },
          { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
        );
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401) return res.status(401).json({ error: "INVALID_PASSWORD" });
        throw e;
      }
    }

    const authPatch = {};
    if (body.phone !== undefined) authPatch.phone = body.phone;
    if (body.newPassword) authPatch.newPassword = body.newPassword;

    let token;
    if (Object.keys(authPatch).length > 0) {
      const { data } = await axios.patch(`${env.AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(targetId)}`, authPatch, {
        headers: { "x-internal-api-key": env.INTERNAL_API_KEY }
      });
      token = data.token;
    }

    if (authUser.role === "DOCTOR") {
      const doctorPatch = {};
      if (body.phone !== undefined) doctorPatch.phone = body.phone;
      if (body.specialization !== undefined) doctorPatch.specialization = body.specialization;
      if (Object.keys(doctorPatch).length > 0) {
        await Doctor.findOneAndUpdate({ authUserId: targetId, deletedAt: null }, doctorPatch);
      }
    }

    if (authUser.role === "PATIENT") {
      const patientPatch = {};
      if (body.phone !== undefined) patientPatch.phone = body.phone;
      if (Object.keys(patientPatch).length > 0) {
        await Patient.findOneAndUpdate({ authUserId: targetId }, patientPatch);
      }
    }

    const updatedAuth = await fetchAuthUser(targetId);
    let profile = null;
    if (updatedAuth.role === "DOCTOR") {
      const doctor = await Doctor.findOne({ authUserId: targetId, deletedAt: null });
      profile = doctor ? { ...doctor.toObject(), id: doctor.authUserId } : null;
    } else if (updatedAuth.role === "PATIENT") {
      const patient = await Patient.findOne({ authUserId: targetId });
      profile = patient ? { ...patient.toObject(), id: patient.authUserId } : null;
    }

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/notify`,
      {
        userId: targetId,
        type: "PROFILE_UPDATE",
        message: selfEdit ? "Your profile was updated successfully." : "An administrator updated your profile."
      },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/activity`,
      { actorUserId: req.user.id, action: "PROFILE_UPDATED", details: { targetUserId: targetId } },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    return res.json({ auth: updatedAuth, profile, token });
  } catch (err) {
    return next(err);
  }
});

module.exports = { profileRoutes: router };

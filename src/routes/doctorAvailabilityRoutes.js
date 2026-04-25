const express = require("express");
const { z } = require("zod");
const axios = require("axios");
const mongoose = require("mongoose");
const env = require("../config/env");
const { requireAuth, requireRole } = require("../middleware/requireAuth");
const { Doctor } = require("../models/Doctor");
const { parseTimeRangeOnDate, findSlotLocation, groupAvailabilityForPublic } = require("../utils/availability");

const router = express.Router();

router.get("/doctor/availability", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const doctor = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });
    return res.json({ availability: groupAvailabilityForPublic(doctor) });
  } catch (err) {
    next(err);
  }
});

const addSlotsSchema = z.object({
  date: z.string().min(10),
  slots: z.array(z.object({ time: z.string().min(3) })).min(1),
  enabled: z.boolean().optional().default(true)
});

router.post("/doctor/availability", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const body = addSlotsSchema.parse(req.body);
    const newSlots = [];
    for (const s of body.slots) {
      const { startTime, endTime, time } = parseTimeRangeOnDate(body.date, s.time);
      if (startTime.getTime() < Date.now() || endTime.getTime() <= startTime.getTime()) {
        return res.status(400).json({ error: "Invalid time selection" });
      }
      newSlots.push({ time, startTime, endTime, enabled: body.enabled, isBooked: false, bookedByPatientId: null, appointmentId: null });
    }

    // Use targeted updates to avoid full-document validation failures
    // (e.g., legacy doctor docs with specialization values outside the new enum).
    const hasDay = await Doctor.exists({ authUserId: req.user.id, deletedAt: null, "availability.date": body.date });
    if (hasDay) {
      await Doctor.updateOne(
        { authUserId: req.user.id, deletedAt: null, "availability.date": body.date },
        { $push: { "availability.$.slots": { $each: newSlots } } }
      );
    } else {
      await Doctor.updateOne(
        { authUserId: req.user.id, deletedAt: null },
        { $push: { availability: { date: body.date, slots: newSlots } } }
      );
    }

    const fresh = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
    if (!fresh) return res.status(404).json({ error: "NOT_FOUND" });
    
    // Emit real-time event
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "availability_updated", payload: { doctorId: fresh.authUserId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error("Failed to emit socket event", e.message);
    }

    return res.json({ availability: groupAvailabilityForPublic(fresh) });
  } catch (err) {
    if (err?.name === "ZodError") return res.status(400).json({ error: "INVALID_SLOT_PAYLOAD" });
    if (String(err.message || "").includes("INVALID")) return res.status(400).json({ error: "Invalid time selection" });
    next(err);
  }
});

const patchSlotSchema = z.object({
  enabled: z.boolean()
});

router.patch("/doctor/availability/:slotId", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const { enabled } = patchSlotSchema.parse(req.body);
    const doctor = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });
    const loc = findSlotLocation(doctor, req.params.slotId);
    if (!loc) return res.status(404).json({ error: "NOT_FOUND" });
    if (loc.slot.isBooked) return res.status(409).json({ error: "SLOT_BOOKED" });
    const path = `availability.${loc.d}.slots.${loc.s}.enabled`;
    await Doctor.updateOne({ authUserId: req.user.id }, { $set: { [path]: enabled } });
    const fresh = await Doctor.findOne({ authUserId: req.user.id });
    
    // Emit real-time event
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "availability_updated", payload: { doctorId: fresh.authUserId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error("Failed to emit socket event", e.message);
    }
    
    return res.json({ availability: groupAvailabilityForPublic(fresh) });
  } catch (err) {
    next(err);
  }
});

router.delete("/doctor/availability/:slotId", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.slotId)) return res.status(400).json({ error: "INVALID_SLOT" });
    const doctor = await Doctor.findOne({ authUserId: req.user.id, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });
    const loc = findSlotLocation(doctor, req.params.slotId);
    if (!loc) return res.status(404).json({ error: "NOT_FOUND" });
    if (loc.slot.isBooked) return res.status(409).json({ error: "SLOT_BOOKED" });

    doctor.availability[loc.d].slots.splice(loc.s, 1);
    if (doctor.availability[loc.d].slots.length === 0) {
      doctor.availability.splice(loc.d, 1);
    }
    doctor.markModified('availability');
    await doctor.save();
    
    // Emit real-time event
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "availability_updated", payload: { doctorId: doctor.authUserId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error("Failed to emit socket event", e.message);
    }
    
    return res.json({ availability: groupAvailabilityForPublic(doctor) });
  } catch (err) {
    next(err);
  }
});

module.exports = { doctorAvailabilityRoutes: router };

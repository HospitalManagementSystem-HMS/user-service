const express = require("express");
const { Doctor } = require("../models/Doctor");
const { groupAvailabilityForPublic } = require("../utils/availability");

const router = express.Router();

router.get("/doctors", async (_req, res, next) => {
  try {
    const doctors = await Doctor.find({ deletedAt: null })
      .sort({ createdAt: -1 })
      .select({ authUserId: 1, name: 1, specialization: 1, email: 1 });
    res.json({
      doctors: doctors.map((d) => ({
        id: d.authUserId,
        name: d.name,
        specialization: d.specialization,
        email: d.email
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.get("/doctors/:doctorId/availability", async (req, res, next) => {
  try {
    const doctor = await Doctor.findOne({ authUserId: req.params.doctorId, deletedAt: null });
    if (!doctor) return res.status(404).json({ error: "NOT_FOUND" });
    const now = Date.now();
    const grouped = groupAvailabilityForPublic(doctor);
    const filtered = grouped
      .map((day) => ({
        date: day.date,
        slots: day.slots.filter((s) => s.enabled !== false && !s.isBooked && new Date(s.endTime).getTime() > now)
      }))
      .filter((d) => d.slots.length > 0);
    res.json({ doctorId: doctor.authUserId, availability: filtered });
  } catch (err) {
    next(err);
  }
});

module.exports = { publicRoutes: router };

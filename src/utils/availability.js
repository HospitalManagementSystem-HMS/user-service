const mongoose = require("mongoose");
const { Doctor } = require("../models/Doctor");

function parseTimeRangeOnDate(dateStr, rangeStr) {
  const parts = rangeStr.split("-").map((s) => s.trim());
  if (parts.length !== 2) throw new Error("INVALID_TIME_RANGE");
  const [startPart, endPart] = parts;

  // Interpret inputs as "hospital local time" (container/server local time).
  // Store as Date (UTC instant) so browsers can render in local time correctly.
  const startTime = new Date(`${dateStr}T${startPart}:00`);
  const endTime = new Date(`${dateStr}T${endPart}:00`);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) throw new Error("INVALID_TIME");
  if (endTime.getTime() <= startTime.getTime()) throw new Error("INVALID_RANGE_ORDER");
  return { startTime, endTime, time: rangeStr };
}

function findSlotLocation(doc, slotId) {
  const sid = String(slotId);
  for (let d = 0; d < (doc.availability || []).length; d += 1) {
    const slots = doc.availability[d].slots || [];
    for (let s = 0; s < slots.length; s += 1) {
      if (String(slots[s]._id) === sid) return { d, s, slot: slots[s] };
    }
  }
  return null;
}

async function lockSlotAtomic({ doctorId, slotId, patientId }) {
  if (!mongoose.Types.ObjectId.isValid(slotId)) return { ok: false, error: "INVALID_SLOT" };
  const oid = new mongoose.Types.ObjectId(slotId);
  const doctor = await Doctor.findOne({ authUserId: doctorId });
  if (!doctor) return { ok: false, error: "DOCTOR_NOT_FOUND" };
  const loc = findSlotLocation(doctor, slotId);
  if (!loc) return { ok: false, error: "SLOT_NOT_FOUND" };
  if (loc.slot.isBooked) return { ok: false, error: "SLOT_ALREADY_BOOKED" };
  if (loc.slot.enabled === false) return { ok: false, error: "SLOT_DISABLED" };

  const pathBooked = `availability.${loc.d}.slots.${loc.s}.isBooked`;
  const pathPatient = `availability.${loc.d}.slots.${loc.s}.bookedByPatientId`;
  const pathId = `availability.${loc.d}.slots.${loc.s}._id`;
  const pathEnabled = `availability.${loc.d}.slots.${loc.s}.enabled`;

  const res = await Doctor.updateOne(
    { authUserId: doctorId, [pathBooked]: false, [pathId]: oid, [pathEnabled]: { $ne: false } },
    { $set: { [pathBooked]: true, [pathPatient]: patientId } }
  );

  if (res.modifiedCount === 0) return { ok: false, error: "SLOT_LOCK_FAILED" };
  return { ok: true, startTime: loc.slot.startTime, endTime: loc.slot.endTime };
}

async function setSlotAppointmentId({ doctorId, slotId, appointmentId }) {
  if (!mongoose.Types.ObjectId.isValid(slotId)) return { ok: false };
  const doctor = await Doctor.findOne({ authUserId: doctorId });
  if (!doctor) return { ok: false };
  const loc = findSlotLocation(doctor, slotId);
  if (!loc) return { ok: false };
  const pathAppt = `availability.${loc.d}.slots.${loc.s}.appointmentId`;
  await Doctor.updateOne({ authUserId: doctorId }, { $set: { [pathAppt]: appointmentId } });
  return { ok: true };
}

async function releaseSlotAtomic({ doctorId, slotId, patientId }) {
  if (!mongoose.Types.ObjectId.isValid(slotId)) return { ok: false, error: "INVALID_SLOT" };
  const oid = new mongoose.Types.ObjectId(slotId);
  const doctor = await Doctor.findOne({ authUserId: doctorId });
  if (!doctor) return { ok: false, error: "DOCTOR_NOT_FOUND" };
  const loc = findSlotLocation(doctor, slotId);
  if (!loc) return { ok: false, error: "SLOT_NOT_FOUND" };
  if (!loc.slot.isBooked) return { ok: true, noop: true };
  if (patientId && loc.slot.bookedByPatientId && String(loc.slot.bookedByPatientId) !== String(patientId)) {
    return { ok: false, error: "SLOT_PATIENT_MISMATCH" };
  }

  const pathBooked = `availability.${loc.d}.slots.${loc.s}.isBooked`;
  const pathPatient = `availability.${loc.d}.slots.${loc.s}.bookedByPatientId`;
  const pathAppt = `availability.${loc.d}.slots.${loc.s}.appointmentId`;
  const pathId = `availability.${loc.d}.slots.${loc.s}._id`;

  const res = await Doctor.updateOne(
    { authUserId: doctorId, [pathId]: oid, [pathBooked]: true },
    { $set: { [pathBooked]: false, [pathPatient]: null, [pathAppt]: null } }
  );
  return { ok: res.modifiedCount > 0 };
}

function groupAvailabilityForPublic(doctor) {
  const days = doctor.availability || [];
  return days.map((day) => ({
    date: day.date,
    slots: (day.slots || []).map((slot) => ({
      slotId: String(slot._id),
      time: slot.time,
      startTime: slot.startTime,
      endTime: slot.endTime,
      isBooked: slot.isBooked,
      enabled: slot.enabled
    }))
  }));
}

function buildAvailabilityDaysFromSpec(spec) {
  if (!spec || spec.length === 0) return [];
  const days = [];
  for (const day of spec) {
    const slots = [];
    for (const s of day.slots || []) {
      const { startTime, endTime, time } = parseTimeRangeOnDate(day.date, s.time);
      slots.push({
        time,
        startTime,
        endTime,
        enabled: true,
        isBooked: false,
        bookedByPatientId: null,
        appointmentId: null
      });
    }
    if (slots.length > 0) days.push({ date: day.date, slots });
  }
  return days;
}

module.exports = {
  parseTimeRangeOnDate,
  findSlotLocation,
  lockSlotAtomic,
  releaseSlotAtomic,
  setSlotAppointmentId,
  groupAvailabilityForPublic,
  buildAvailabilityDaysFromSpec
};

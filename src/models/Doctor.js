const mongoose = require("mongoose");
const { SPECIALIZATIONS } = require("../constants/specializations");

const slotSchema = new mongoose.Schema(
  {
    time: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    isBooked: { type: Boolean, default: false },
    bookedByPatientId: { type: String, default: null },
    appointmentId: { type: String, default: null },
    enabled: { type: Boolean, default: true }
  },
  { _id: true }
);

const dayAvailabilitySchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    slots: { type: [slotSchema], default: [] }
  },
  { _id: false }
);

const doctorSchema = new mongoose.Schema(
  {
    authUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, immutable: true },
    name: { type: String, required: true, immutable: true },
    phone: { type: String, default: "" },
    specialization: { type: String, required: true, enum: SPECIALIZATIONS },
    experienceYears: { type: Number, default: 0 },
    availability: { type: [dayAvailabilitySchema], default: [] },
    deletedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

const Doctor = mongoose.model("Doctor", doctorSchema);

module.exports = { Doctor };

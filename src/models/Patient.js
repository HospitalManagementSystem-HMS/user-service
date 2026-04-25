const mongoose = require("mongoose");

const patientSchema = new mongoose.Schema(
  {
    authUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, immutable: true },
    name: { type: String, required: true, immutable: true },
    phone: { type: String, default: "" }
  },
  { timestamps: true }
);

const Patient = mongoose.model("Patient", patientSchema);

module.exports = { Patient };

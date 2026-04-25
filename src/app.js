const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { publicRoutes } = require("./routes/publicRoutes");
const { userRoutes } = require("./routes/userRoutes");
const { profileRoutes } = require("./routes/profileRoutes");
const { doctorAvailabilityRoutes } = require("./routes/doctorAvailabilityRoutes");
const { internalRoutes } = require("./routes/internalRoutes");
const { notFound, errorHandler } = require("./utils/errors");

function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("tiny"));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "user" }));

  app.use(publicRoutes);
  app.use(userRoutes);
  app.use(profileRoutes);
  app.use(doctorAvailabilityRoutes);
  app.use("/internal", internalRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };


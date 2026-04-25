const axios = require("axios");

function notFound(_req, res) {
  res.status(404).json({ error: "NOT_FOUND" });
}

function errorHandler(err, _req, res, _next) {
  // eslint-disable-next-line no-console
  console.error(err);

  if (axios.isAxiosError(err) && err.response) {
    return res.status(err.response.status).json(err.response.data);
  }

  if (err && err.name === "ZodError") {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: err.issues });
  }

  if (err && err.code === 11000) {
    return res.status(409).json({ error: "DUPLICATE_RESOURCE" });
  }

  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
}

module.exports = { notFound, errorHandler };


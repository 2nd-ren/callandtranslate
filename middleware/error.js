import logger from "./logger.js";

export default function (err, req, res, next) {
  const errorDetails = {
    message: err.message,
    stack: err.stack,
    request: {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query: req.query,
      body: req.body,
      ip: req.ip,
    },
    // Additional context
    environment: process.env.NODE_ENV,
    user: req.user ? req.user._id : "anonymous", // Assuming req.user is populated
  };

  logger.error({
    message: `Error occurred: ${err.message} - Request: ${req.method} ${req.path}`,
    meta: errorDetails,
  });
  // Respond with the status code set in the route, defaulting to 500 if not set
  const statusCode = err.statusCode || 500;

  // Send the error message from the route or a generic message if not available
  const errorMessage = err.message || "Something failed and went wrong.";

  res.status(statusCode).send(errorMessage);
}

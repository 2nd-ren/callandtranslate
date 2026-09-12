import "express-async-errors"; //library that wraps routes in error middleware
import winston from "winston";
//-------------!!!----------enable winston mongodb logging after integration testing
// import "winston-mongodb"; //enable this after integration testing

// Create a custom Winston logger
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.prettyPrint(), // Print the log in a readable format
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "logfile.log", level: "info" }),
    //-------------!!!----------enable winston mongodb logging after integration testing
    // new winston.transports.MongoDB({
    //   db: "mongodb://127.0.0.1/vidly",
    //   options: { useUnifiedTopology: true },
    //   collection: "log",
    //   level: "info",
    //   metaKey: "meta", // Explicitly set the metaKey option
    //   format: winston.format.combine(
    //     winston.format.timestamp(),
    //     winston.format.prettyPrint(), // Print the log in a readable format
    //     winston.format.json()
    //   ),
    // }),
    // Add a new transport for uncaught exceptions
    new winston.transports.File({
      filename: "uncaughtexceptions.log",
      handleExceptions: true,
      level: "error",
    }),
    // Add a new transport for uncaught exceptions to console
    new winston.transports.Console({
      colorize: true,
      prettyPrint: true,
      handleExceptions: true,
      level: "error",
    }),
    //-------------!!!----------enable winston mongodb logging after integration testing
    // new winston.transports.MongoDB({
    //   db: "mongodb://127.0.0.1/vidly",
    //   options: { useUnifiedTopology: true },
    //   handleExceptions: true,

    //   collection: "log",
    //   level: "info",
    //   metaKey: "meta", // Explicitly set the metaKey option
    //   format: winston.format.combine(
    //     winston.format.timestamp(),
    //     winston.format.prettyPrint(), // Print the log in a readable format
    //     winston.format.json()
    //   ),
    // }),
  ],
});

// Handling uncaught exceptions
process.on("uncaughtException", (ex) => {
  console.log("We have an uncaught exception");

  const errorDetails = {
    message: ex.message,
    stack: ex.stack,
  };

  // Log the error and exit once logging is complete
  logger.error({ message: "Uncaught Exception", meta: errorDetails }, () => {
    process.exit(1);
  });
});

// Handling unhandled rejections
process.on("unhandledRejection", (ex) => {
  console.log("We have an unhandled rejection");

  const errorDetails = {
    message: ex.message,
    stack: ex.stack,
  };

  // Log the error and exit once logging is complete
  logger.error({ message: "Unhandled Rejection", meta: errorDetails }, () => {
    process.exit(1);
  });
});

export default logger;

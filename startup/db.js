import mongoose from "mongoose";
import logger from "../middleware/logger.js";
import config from "config";
import { startAccountDeletionSweeper } from "../utils/accountDeletion.js";
import seedInitialAdmins from "./seedAdmins.js";

export default function () {
  const db = config.get("db");
  mongoose
    .connect(db, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    .then(() => {
      const safe = String(db).replace(/\/\/([^@/]+)@/, "//***@");
      console.log(`Connected to MongoDB...${safe}`);
      logger.info(`Connected to MongoDB...${safe}`);
      startAccountDeletionSweeper();
      seedInitialAdmins().catch((error) => {
        logger.error(`Admin seed failed: ${error.message}`);
        console.error("Admin seed failed:", error);
      });
    })
    .catch((error) => {
      logger.error(`MongoDB startup initialization failed: ${error.message}`);
      console.error("MongoDB startup initialization failed:", error);
    });
}

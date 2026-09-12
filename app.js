import express from "express";
import routes from "./startup/routes.js";
import db from "./startup/db.js";
import loadConfig from "./startup/config.js";
import validation from "./startup/validation.js";
import prod from "./startup/prod.js";

const app = express();
app.set("trust proxy", 1);

loadConfig();
validation();
routes(app);
prod(app);

if (process.env.NODE_ENV !== "test") {
  db();
}

export default app;

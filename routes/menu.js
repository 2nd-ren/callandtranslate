import express from "express";
import auth from "../middleware/auth.js";
import { User } from "../models/user.js";
import { getMainMenu } from "../config/menuConfig.js";

const router = express.Router();

router.get("/main", auth, async (req, res) => {
  const user = await User.findById(req.user._id).select("isAdmin role");
  if (!user) return res.status(404).send("User not found.");
  const menu = getMainMenu({
    isAdmin: Boolean(user.isAdmin),
    role: user.role,
  });
  return res.send({
    menu,
    context: { isAdmin: Boolean(user.isAdmin), role: user.role },
  });
});

export default router;

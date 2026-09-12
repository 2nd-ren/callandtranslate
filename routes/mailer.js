import crypto from "crypto";
import express from "express";
import { sendAppMail, AUTH_MAIL_ADDRESS } from "../utils/sendMail.js";

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const router = express.Router();

router.post("/send", express.json({ limit: "1mb" }), async (req, res) => {
  if (!safeCompare(req.body.secretKey, process.env.INTERNAL_API_SECRET)) {
    return res.status(403).send({ error: "Forbidden" });
  }

  try {
    const result = await sendAppMail({
      to: req.body.to,
      subject: req.body.subject,
      html: req.body.html,
      from: req.body.from || AUTH_MAIL_ADDRESS,
    });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).send({ error: `Failed to send email: ${error.message}` });
  }
});

export default router;

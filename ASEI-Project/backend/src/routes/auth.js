// src/routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { Issuer, generators } from "openid-client";
import { sendMail, verificationEmail } from "../mailer.js";

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";

function cookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAgeMs,
  };
}

/* ============================
   SIGNUP (always leads to verify)
   ============================ */
router.post("/signup", async (req, res) => {
  const { email, password, firstName, lastName } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const lowerEmail = email.toLowerCase();

    // block if already verified
    const dupUser = await query("SELECT 1 FROM users WHERE email=$1", [lowerEmail]);
    if (dupUser.rowCount) {
      return res.status(400).json({ error: "Email already registered. Try logging in." });
    }

    const hashed = await bcrypt.hash(password, 10);
    const code = String(Math.floor(100000 + Math.random() * 900000));

    const pending = await query("SELECT 1 FROM pending_users WHERE email=$1", [lowerEmail]);
    if (pending.rowCount) {
      await query(
        "UPDATE pending_users SET verification_code=$2, first_name=COALESCE($3, first_name), last_name=COALESCE($4, last_name) WHERE email=$1",
        [lowerEmail, code, firstName || null, lastName || null]
      );
    } else {
      await query(
        `INSERT INTO pending_users (email, first_name, last_name, password_hash, verification_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [lowerEmail, firstName || null, lastName || null, hashed, code]
      );
    }

    const { text, html } = verificationEmail(code);
    await sendMail({
      to: lowerEmail,
      subject: "Verify your Connectify account",
      text,
      html,
    });

    // save pending email in cookie for 15 min
    res.cookie("pending_email", lowerEmail, cookieOpts(15 * 60 * 1000));

    return res.status(201).json({
      message: "Check your email for a verification code",
      email: lowerEmail,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   VERIFY
   ============================ */
router.post("/verify", async (req, res) => {
  const code = req.body?.code;
  const bodyEmail = (req.body?.email || "").toLowerCase();
  const cookieEmail = (req.cookies?.pending_email || "").toLowerCase();
  const email = bodyEmail || cookieEmail;

  if (!email || !code) {
    return res.status(400).json({ error: "Email and verification code are required." });
  }

  try {
    const pending = await query("SELECT * FROM pending_users WHERE email=$1", [email]);
    if (!pending.rowCount) {
      return res.status(400).json({ error: "No pending account for this email." });
    }

    const p = pending.rows[0];
    if (p.verification_code !== code) {
      return res.status(400).json({ error: "Invalid verification code." });
    }

    const orgRes = await query("SELECT id FROM organizations WHERE name=$1", ["DefaultOrg"]);
    const orgId = orgRes.rowCount
      ? orgRes.rows[0].id
      : (await query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", ["DefaultOrg"])).rows[0].id;

    const created = await query(
      `INSERT INTO users (org_id, email, first_name, last_name, password_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, first_name, last_name, org_id`,
      [orgId, p.email, p.first_name, p.last_name, p.password_hash]
    );

    await query("DELETE FROM pending_users WHERE email=$1", [email]);
    res.clearCookie("pending_email", cookieOpts(0));

    res.json({ message: "Account verified successfully", user: created.rows[0] });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   RESEND CODE (with cooldown)
   ============================ */
router.post("/resend-code", async (req, res) => {
  const bodyEmail = (req.body?.email || "").toLowerCase();
  const cookieEmail = (req.cookies?.pending_email || "").toLowerCase();
  const email = bodyEmail || cookieEmail;

  if (!email) return res.status(400).json({ error: "Email is required." });

  try {
    const { rows, rowCount } = await query(
      `SELECT last_verification_email_sent_at
         FROM pending_users
        WHERE email = $1`,
      [email]
    );
    if (!rowCount) {
      return res.status(400).json({ error: "No pending account for this email." });
    }

    const COOLDOWN_SEC = 60; // <-- set your window here
    const now = new Date();
    const last = rows[0].last_verification_email_sent_at
      ? new Date(rows[0].last_verification_email_sent_at)
      : null;

    if (last) {
      const diffSec = (now - last) / 1000;
      if (diffSec < COOLDOWN_SEC) {
        const wait = Math.ceil(COOLDOWN_SEC - diffSec);
        return res.status(429).json({
          error: `Please wait ${wait}s before trying again.`,
          nextEligibleAtMs: now.getTime() + wait * 1000,
        });
      }
    }

    // Generate & save new code + update cooldown timestamp
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await query(
      `UPDATE pending_users
          SET verification_code = $2,
              last_verification_email_sent_at = now()
        WHERE email = $1`,
      [email, code]
    );

    const { text, html } = verificationEmail(code);
    await sendMail({
      to: email,
      subject: "Your Connectify verification code",
      text,
      html,
    });

    // Tell client exactly when they can click again
    res.json({ message: "Verification code resent.", nextEligibleAtMs: now.getTime() + COOLDOWN_SEC * 1000 });
  } catch (err) {
    console.error("Resend code error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


export default router;

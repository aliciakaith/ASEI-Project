// src/routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { Issuer, generators } from "openid-client";
import { sendMail, verificationEmail } from "../mailer.js";

// ---- Password policy helper (server-side) ----
function validatePassword(password, { email, firstName, lastName } = {}) {
  const failures = [];

  const rules = [
    { ok: /.{8,}/.test(password), msg: "At least 8 characters long" },
    { ok: /[a-z]/.test(password),  msg: "At least one lowercase letter" },
    { ok: /[A-Z]/.test(password),  msg: "At least one uppercase letter" },
    { ok: /\d/.test(password),     msg: "At least one number" },
    { ok: /[@$!%*?&.#^]/.test(password), msg: "At least one special character (@ $ ! % * ? & . # ^)" },
  ];

  // optional hardening: avoid obvious personal info
  const lowerPw = password.toLowerCase();
  const partsToAvoid = [];
  if (email) {
    const local = String(email).toLowerCase().split("@")[0];
    if (local && local.length >= 3) partsToAvoid.push(local);
  }
  if (firstName && String(firstName).length >= 3) partsToAvoid.push(String(firstName).toLowerCase());
  if (lastName && String(lastName).length >= 3) partsToAvoid.push(String(lastName).toLowerCase());

  if (partsToAvoid.some(p => lowerPw.includes(p))) {
    failures.push("Should not contain your name or email.");
  }

  // simple repeated/sequence checks (optional)
  if (/(.)\1{2,}/.test(password)) {
    failures.push("Should not contain 3+ repeated characters in a row.");
  }
  if (/1234|abcd|qwer|password|letmein|welcome/i.test(password)) {
    failures.push("Avoid common/weak patterns (e.g., 'password', '1234').");
  }

  for (const r of rules) if (!r.ok) failures.push(r.msg);

  return {
    ok: failures.length === 0,
    failures
  };
}


// --- Google OpenID Connect setup ---
const GOOGLE_REDIRECT =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

const FRONTEND_BASE =
  process.env.FRONTEND_ORIGIN || 'http://localhost:3000'; // your env already sets this

let googleClient;
async function getGoogleClient() {
  if (googleClient) return googleClient;
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  googleClient = new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [GOOGLE_REDIRECT],
    response_types: ['code'],
  });
  return googleClient;
}


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

  // 🔐 Enforce server-side password policy
  const { ok, failures } = validatePassword(password, { email, firstName, lastName });
  if (!ok) {
    return res.status(400).json({
      error: "Password does not meet requirements.",
      failures // e.g., [ "At least one uppercase letter", "At least one number" ]
    });
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

/* ============================
   LOGIN  (supports Remember Me)
   ============================ */
router.post("/login", async (req, res) => {
  const { email, password, remember } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const lowerEmail = email.toLowerCase();

    // Look up verified user
    const { rows, rowCount } = await query(
      "SELECT id, email, password_hash, first_name, last_name, org_id FROM users WHERE email=$1",
      [lowerEmail]
    );
    if (!rowCount) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // Cookie + token lifetimes
    const jwtTtl = remember ? "30d" : "1d";                 // token lifetime
    const cookieMaxAge = remember ? 30*24*60*60*1000 : 24*60*60*1000; // 30d vs 1d

    // Issue JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, org: user.org_id },
      SECRET,
      { expiresIn: jwtTtl }
    );

    // Set cookie
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: cookieMaxAge,
      path: "/",
    });

    res.json({
      ok: true,
      user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// POST /api/auth/logout
router.post("/logout", (req, res) => {
  // If you set a JWT cookie on login, clear it here.
  // (Change 'token' to your actual cookie name if different.)
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  // Also clear the pending email cookie used during signup/verify (harmless if absent)
  res.clearCookie("pending_email", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  // If you also stash anything in localStorage on the client, clear it there (frontend).
  return res.status(204).end();
});

// Start Google sign-in
router.get('/google', async (req, res) => {
  try {
    const client = await getGoogleClient();
    const state = generators.state();
    const nonce = generators.nonce();

    const secure = process.env.NODE_ENV === 'production';
    res.cookie('g_state', state, { httpOnly: true, sameSite: 'lax', secure });
    res.cookie('g_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure });

    const authUrl = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      prompt: 'select_account',
    });

    return res.redirect(authUrl);
  } catch (e) {
    console.error('Google init error:', e);
    res.status(500).json({ error: 'Google OAuth init failed' });
  }
});

// Google OAuth callback
// Google OAuth callback
router.get('/google/callback', async (req, res) => {
  try {
    const client = await getGoogleClient();
    const params = client.callbackParams(req);

    const cookieState = req.cookies?.g_state;
    const cookieNonce = req.cookies?.g_nonce;

    // Exchange code for tokens + verify state/nonce
    const tokenSet = await client.callback(GOOGLE_REDIRECT, params, {
      state: cookieState,
      nonce: cookieNonce,
    });

    // Pull profile (email, name, etc.)
    const userinfo = await client.userinfo(tokenSet.access_token);
    const email = (userinfo.email || '').toLowerCase();
    if (!email) {
      console.error('Google callback error: missing email in userinfo:', userinfo);
      return res.status(400).send('Google did not return an email address.');
    }

    // ----- UPSERT USER -----
    // Find existing user
    let { rows, rowCount } = await query(
      'SELECT id, org_id FROM users WHERE email=$1',
      [email]
    );

    let user;
    if (!rowCount) {
      // Ensure DefaultOrg exists (your verify route already uses this)
      const orgRes = await query('SELECT id FROM organizations WHERE name=$1', ['DefaultOrg']);
      const orgId = orgRes.rowCount
        ? orgRes.rows[0].id
        : (await query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', ['DefaultOrg'])).rows[0].id;

      // Insert new user (no password_hash for Google accounts)
      const inserted = await query(
        `INSERT INTO users (org_id, email, first_name, last_name)
         VALUES ($1,$2,$3,$4)
         RETURNING id, email, org_id`,
        [orgId, email, userinfo.given_name || null, userinfo.family_name || null]
      );
      user = inserted.rows[0];
    } else {
      user = rows[0];
    }

    // ----- ISSUE SESSION COOKIE -----
    const token = jwt.sign(
      { id: user.id, email, org: user.org_id },
      SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    // Clear temp cookies
    const secure = process.env.NODE_ENV === 'production';
    res.clearCookie('g_state', { httpOnly: true, sameSite: 'lax', secure });
    res.clearCookie('g_nonce', { httpOnly: true, sameSite: 'lax', secure });

    // Redirect to your dashboard (env-driven)
    return res.redirect(`${FRONTEND_BASE}/asei_dashboard.html`);
  } catch (e) {
    // Log the actual error to diagnose issues (mismatch, bad state/nonce, etc.)
    console.error('Google callback error:', e?.response?.body || e?.message || e);
    res.status(500).json({ error: 'Google OAuth callback failed' });
  }
});

// GET /api/auth/me
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: "Not logged in" });

    const payload = jwt.verify(token, SECRET); // throws if expired/invalid

    const { rows, rowCount } = await query(
      "SELECT id, email, first_name, last_name, org_id FROM users WHERE id=$1",
      [payload.id]
    );
    if (!rowCount) return res.status(401).json({ error: "Unknown user" });

    const u = rows[0];
    res.json({
      ok: true,
      user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name }
    });
  } catch (e) {
    return res.status(401).json({ error: "Session expired" });
  }
});




export default router;

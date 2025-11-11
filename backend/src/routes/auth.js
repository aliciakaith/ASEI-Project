// src/routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { Issuer, generators } from "openid-client";
import { sendMail, verificationEmail } from "../mailer.js";
import { audit } from "../logging/audit.js";
import { sendErrorAlert } from "../utils/errorNotification.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import multer from 'multer';

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
  const lowerPw = String(password || "").toLowerCase();
  const partsToAvoid = [];
  if (email) {
    const local = String(email).toLowerCase().split("@")[0];
    if (local && local.length >= 3) partsToAvoid.push(local);
  }
  if (firstName && String(firstName).length >= 3) partsToAvoid.push(String(firstName).toLowerCase());
  if (lastName && String(lastName).length >= 3) partsToAvoid.push(String(lastName).toLowerCase());

  if (partsToAvoid.some(p => lowerPw.includes(p))) {
    failures.push("Password should not contain your name or email.");
  }

  if (/(.)\1{2,}/.test(password)) {
    failures.push("Should not contain 3+ repeated characters in a row.");
  }
  if (/1234|abcd|qwer|password|letmein|welcome/i.test(password)) {
    failures.push("Avoid common or weak patterns (e.g., 'password', '1234').");
  }

  for (const r of rules) if (!r.ok) failures.push(r.msg);

  return { ok: failures.length === 0, failures };
}

// --- Google OpenID Connect setup ---
const GOOGLE_REDIRECT =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";

// Remove trailing slash to prevent double slashes in redirects
const FRONTEND_BASE =
  (process.env.FRONTEND_ORIGIN || "http://localhost:3000").replace(/\/$/, '');

let googleClient;
async function getGoogleClient() {
  if (googleClient) return googleClient;
  const googleIssuer = await Issuer.discover("https://accounts.google.com");
  googleClient = new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [GOOGLE_REDIRECT],
    response_types: ["code"],
  });
  return googleClient;
}

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";

// Helper function to capitalize names properly
function capitalizeName(name) {
  if (!name || typeof name !== 'string') return name;
  return name.trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function cookieOpts(maxAgeMs) {
  const IS_PROD = process.env.NODE_ENV === "production";
  // In dev: use None to allow cross-origin (different IPs on LAN)
  // Note: Modern browsers require Secure with SameSite=None, but in dev over plain HTTP
  // we'll still set None and many browsers will allow it for localhost/LAN
  // In prod: use Lax with Secure for better security on HTTPS
  return {
    httpOnly: true,
    sameSite: IS_PROD ? "lax" : "none",
    secure: IS_PROD, // Secure flag only in production
    maxAge: maxAgeMs,
    path: "/",
  };
}

/* ============================
   FORGOT PASSWORD (PUBLIC)
   ============================ */
router.post("/forgot", async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required." });

  try {
    // Audit the request (no enumeration: we audit regardless of user existence)
    await audit(req, {
      userId: null,
      action: "PWD_RESET_REQUEST",
      targetType: "user",
      targetId: email,
      statusCode: 200
    });

    // Silent lookup (no user enumeration)
    const { rows, rowCount } = await query("SELECT id FROM users WHERE email=$1", [email]);

    if (rowCount) {
      const userId = rows[0].id;

      const resetToken = jwt.sign({ sub: userId, kind: "pwd_reset" }, SECRET, { expiresIn: "15m" });
      const resetLink = `${FRONTEND_BASE}/forgot.html?token=${encodeURIComponent(resetToken)}`;

      try {
        await sendMail({
          to: email,
          subject: "Reset your Connectify password",
          text: `Use this link to reset your password (valid for 15 minutes): ${resetLink}`,
          html: `<p>Use this link to reset your password (valid for 15 minutes):</p>
                 <p><a href="${resetLink}">${resetLink}</a></p>`
        });
      } catch (mailErr) {
        // do NOT rethrow — we always return 200 to avoid enumeration
      }
    }

    return res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   RESET PASSWORD (PUBLIC)
   ============================ */
router.post("/reset", async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    await audit(req, {
      userId: null,
      action: "PWD_RESET_FAILURE",
      targetType: "user",
      targetId: null,
      statusCode: 400,
      metadata: { reason: "missing_params" }
    });
    return res.status(400).json({ error: "Token and new password are required." });
  }

  try {
    const payload = jwt.verify(token, SECRET); // throws if bad/expired
    if (payload.kind !== "pwd_reset") {
      await audit(req, {
        userId: null,
        action: "PWD_RESET_FAILURE",
        targetType: "user",
        targetId: null,
        statusCode: 400,
        metadata: { reason: "invalid_kind" }
      });
      return res.status(400).json({ error: "Invalid reset token." });
    }

    const { ok, failures } = validatePassword(password);
    if (!ok) {
      return res.status(400).json({
        error: `Password does not meet requirements: ${failures.join("; ")}`,
        failures
      });
    }

    const hash = await bcrypt.hash(password, 10);
    await query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, payload.sub]);

    await audit(req, {
      userId: payload.sub,
      action: "PWD_RESET_SUCCESS",
      targetType: "user",
      targetId: payload.sub,
      statusCode: 200
    });

    return res.json({ message: "Password updated successfully." });
  } catch (e) {
    const reason = e?.name === "TokenExpiredError" ? "expired" : "invalid_token";
    await audit(req, {
      userId: null,
      action: "PWD_RESET_FAILURE",
      targetType: "user",
      targetId: null,
      statusCode: 400,
      metadata: { reason }
    });
    const msg = e?.name === "TokenExpiredError"
      ? "Reset link has expired. Request a new one."
      : "Invalid reset token.";
    return res.status(400).json({ error: msg });
  }
});

/* ============================
   SIGNUP (always leads to verify)
   ============================ */
router.post("/signup", async (req, res) => {
  const { email, password, firstName, lastName } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  // Capitalize names properly
  const capitalizedFirstName = capitalizeName(firstName);
  const capitalizedLastName = capitalizeName(lastName);

  const { ok, failures } = validatePassword(password, { email, firstName: capitalizedFirstName, lastName: capitalizedLastName });
  if (!ok) {
    const message = failures.length
      ? `${failures.join("; ")}`
      : "Password does not meet requirements.";
    return res.status(400).json({ error: message, failures });
  }

  try {
    const lowerEmail = email.toLowerCase();

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
        [lowerEmail, code, capitalizedFirstName || null, capitalizedLastName || null]
      );
    } else {
      await query(
        `INSERT INTO pending_users (email, first_name, last_name, password_hash, verification_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [lowerEmail, capitalizedFirstName || null, capitalizedLastName || null, hashed, code]
      );
    }

    const { text, html } = verificationEmail(code);
    // Send email in background - don't block signup if SMTP fails
    sendMail({
      to: lowerEmail,
      subject: "Verify your Connectify account",
      text,
      html,
    }).catch(err => {
      console.error("Failed to send verification email:", err.message);
    });

    // save pending email in cookie for 15 min
    res.cookie("pending_email", lowerEmail, cookieOpts(15 * 60 * 1000));

    await audit(req, {
      userId: null,
      action: "SIGNUP_SUBMITTED",
      targetType: "user",
      targetId: lowerEmail,
      statusCode: 201
    });

    return res.status(201).json({
      message: "Check your email for a verification code",
      email: lowerEmail,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
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

    await audit(req, {
      userId: created.rows[0].id,
      action: "ACCOUNT_VERIFIED",
      targetType: "user",
      targetId: created.rows[0].id,
      statusCode: 200
    });

    res.json({ message: "Account verified successfully", user: created.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
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

    const COOLDOWN_SEC = 60;
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

    await audit(req, {
      userId: null,
      action: "VERIFY_CODE_RESENT",
      targetType: "user",
      targetId: email,
      statusCode: 200
    });

    res.json({ message: "Verification code resent.", nextEligibleAtMs: now.getTime() + COOLDOWN_SEC * 1000 });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
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
      await audit(req, {
        userId: null,
        action: "LOGIN_FAILURE",
        targetType: "user",
        targetId: lowerEmail,
        statusCode: 401,
        metadata: { reason: "no_user" }
      });
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      await audit(req, {
        userId: null,
        action: "LOGIN_FAILURE",
        targetType: "user",
        targetId: lowerEmail,
        statusCode: 401,
        metadata: { reason: "bad_password" }
      });
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const jwtTtl = remember ? "30d" : "1d";
    const cookieMaxAge = remember ? 30*24*60*60*1000 : 24*60*60*1000;

    const token = jwt.sign(
      { id: user.id, email: user.email, org: user.org_id },
      SECRET,
      { expiresIn: jwtTtl }
    );

    // Use consistent cookie policy via cookieOpts helper
    const primaryOpts = cookieOpts(cookieMaxAge);
    res.cookie("token", token, primaryOpts);

    // Dev fallback: some browsers may silently drop SameSite=None without Secure over HTTP.
    // Issue an additional Lax cookie so local flows still work while we debug.
    if (process.env.NODE_ENV !== 'production') {
      const laxFallback = { ...primaryOpts, sameSite: 'lax' };
      res.cookie('token_lax', token, laxFallback);
    }

    console.log(`[auth] LOGIN_SUCCESS for ${user.email} – issued token cookie sameSite=${primaryOpts.sameSite}` + (process.env.NODE_ENV !== 'production' ? ' + fallback token_lax (lax)' : '')); 

    await audit(req, {
      userId: user.id,
      action: "LOGIN_SUCCESS",
      targetType: "user",
      targetId: user.id,
      statusCode: 200
    });

    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name }
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// helper to clear auth-related cookies in a robust way
function clearAuthCookies(req, res) {
  const IS_PROD = process.env.NODE_ENV === "production";
  const baseNone = { httpOnly: true, sameSite: "none", secure: IS_PROD, path: "/" };
  const baseLax  = { httpOnly: true, sameSite: "lax",  secure: IS_PROD, path: "/" };
  const baseNoneApi = { ...baseNone, path: "/api" };
  const baseLaxApi  = { ...baseLax,  path: "/api" };

  // Clear token cookie in both SameSite modes to cover historical values
  res.clearCookie("token", baseNone);
  res.clearCookie("token", baseLax);
  res.clearCookie("token", baseNoneApi);
  res.clearCookie("token", baseLaxApi);
  // Also clear fallback dev cookie if present
  res.clearCookie("token_lax", baseNone);
  res.clearCookie("token_lax", baseLax);
  res.clearCookie("token_lax", baseNoneApi);
  res.clearCookie("token_lax", baseLaxApi);
  // Force-expire as extra safety
  res.cookie("token", "", { ...baseNone,    expires: new Date(0) });
  res.cookie("token", "", { ...baseLax,     expires: new Date(0) });
  res.cookie("token", "", { ...baseNoneApi, expires: new Date(0) });
  res.cookie("token", "", { ...baseLaxApi,  expires: new Date(0) });
  res.cookie("token_lax", "", { ...baseNone,    expires: new Date(0) });
  res.cookie("token_lax", "", { ...baseLax,     expires: new Date(0) });
  res.cookie("token_lax", "", { ...baseNoneApi, expires: new Date(0) });
  res.cookie("token_lax", "", { ...baseLaxApi,  expires: new Date(0) });

  // Clear any auxiliary cookies used during flows
  ["pending_email", "g_state", "g_nonce"].forEach((name) => {
    res.clearCookie(name, baseNone);
    res.clearCookie(name, baseLax);
    res.clearCookie(name, baseNoneApi);
    res.clearCookie(name, baseLaxApi);
    res.cookie(name, "", { ...baseNone,    expires: new Date(0) });
    res.cookie(name, "", { ...baseLax,     expires: new Date(0) });
    res.cookie(name, "", { ...baseNoneApi, expires: new Date(0) });
    res.cookie(name, "", { ...baseLaxApi,  expires: new Date(0) });
  });
}

// POST /api/auth/logout
router.post("/logout", async (req, res) => {
  clearAuthCookies(req, res);

  await audit(req, {
    userId: req.user?.id || null,
    action: "LOGOUT",
    targetType: "user",
    targetId: req.user?.id || null,
    statusCode: 204,
  });

  return res.status(204).end();
});

// Also support GET for environments where forms/links are used
router.get("/logout", async (req, res) => {
  clearAuthCookies(req, res);
  await audit(req, {
    userId: req.user?.id || null,
    action: "LOGOUT",
    targetType: "user",
    targetId: req.user?.id || null,
    statusCode: 204,
  });
  return res.status(204).end();
});


// Start Google sign-in
router.get("/google", async (req, res) => {
  try {
    const client = await getGoogleClient();
    const state = generators.state();
    const nonce = generators.nonce();

    // Use SameSite=Lax so cookies survive OAuth cross-site redirect back to our domain
    // Note: SameSite=None without Secure is rejected by modern browsers, and dev is over HTTP.
    const IS_PROD = process.env.NODE_ENV === "production";
    const cookieBase = { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/", maxAge: 10 * 60 * 1000 };
    res.cookie("g_state", state, cookieBase);
    res.cookie("g_nonce", nonce, cookieBase);

    const authUrl = client.authorizationUrl({
      scope: "openid email profile",
      state,
      nonce,
      prompt: "select_account",
    });

    return res.redirect(authUrl);
  } catch (e) {
    return res.status(500).json({ error: "Google OAuth init failed" });
  }
});

// Google OAuth callback
router.get("/google/callback", async (req, res) => {
  const dev = process.env.NODE_ENV !== "production";
  try {
    const client = await getGoogleClient();
    const params = client.callbackParams(req);

    const cookieState = req.cookies?.g_state;
    const cookieNonce = req.cookies?.g_nonce;

    if (!cookieState || !cookieNonce) {
      const message = "Missing OAuth state/nonce cookies. Please start the Google sign-in again.";
      if (dev) {
        return res.status(400).json({ error: "Google OAuth callback failed", details: message, got: { state: !!cookieState, nonce: !!cookieNonce } });
      }
      return res.status(400).send(message);
    }

    // IMPORTANT: pass the same redirect URI you registered
    const tokenSet = await client.callback(GOOGLE_REDIRECT, params, {
      state: cookieState,
      nonce: cookieNonce,
    });

    const claims = tokenSet.claims();
    const email = (claims.email || "").toLowerCase();
    if (!email) {
      const msg = "[OAuth] No email in ID token claims";
      return dev ? res.status(400).json({ error: msg, claims })
                 : res.status(400).send("Google did not return an email address.");
    }

    // ----- UPSERT USER -----
    let { rows, rowCount } = await query("SELECT id, org_id FROM users WHERE email=$1", [email]);
    let user;
    if (!rowCount) {
      const orgRes = await query("SELECT id FROM organizations WHERE name=$1", ["DefaultOrg"]);
      const orgId = orgRes.rowCount
        ? orgRes.rows[0].id
        : (await query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", ["DefaultOrg"])).rows[0].id;

      // Capitalize names from Google OAuth
      const firstName = capitalizeName(claims.given_name);
      const lastName  = capitalizeName(claims.family_name);

      const inserted = await query(
        `INSERT INTO users (org_id, email, first_name, last_name)
         VALUES ($1,$2,$3,$4)
         RETURNING id, email, org_id`,
        [orgId, email, firstName || null, lastName || null]
      );
      user = inserted.rows[0];
    } else {
      user = rows[0];
    }

    const IS_PROD = process.env.NODE_ENV === "production";
    const token = jwt.sign({ id: user.id, email, org: user.org_id }, SECRET, { expiresIn: "7d" });
    // Use consistent cookie policy via cookieOpts helper
    const primaryOpts = cookieOpts(7 * 24 * 60 * 60 * 1000);
    res.cookie("token", token, primaryOpts);
    if (!IS_PROD) {
      const laxFallback = { ...primaryOpts, sameSite: 'lax' };
      res.cookie('token_lax', token, laxFallback);
    }
    console.log(`[auth] OAUTH_LOGIN_SUCCESS for ${email} – issued token cookie sameSite=${primaryOpts.sameSite}` + (!IS_PROD ? ' + fallback token_lax (lax)' : ''));

    res.clearCookie("g_state", { httpOnly: true, sameSite: IS_PROD ? "lax" : "none", secure: IS_PROD });
    res.clearCookie("g_nonce", { httpOnly: true, sameSite: IS_PROD ? "lax" : "none", secure: IS_PROD });

    // (Optional) You can also audit OAuth login success:
    // await audit(req, {
    //   userId: user.id,
    //   action: "LOGIN_SUCCESS_OAUTH",
    //   targetType: "user",
    //   targetId: user.id,
    //   statusCode: 302
    // });

    return res.redirect(`${FRONTEND_BASE}/asei_dashboard.html`);
  } catch (e) {
    const details = e?.response?.body || e?.message || String(e);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({ error: "Google OAuth callback failed", details });
    }
    return res.status(500).json({ error: "Google OAuth callback failed" });
  }
});

// GET /api/auth/me
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.token || req.cookies?.token_lax;
    console.log('[/api/auth/me] Token exists:', !!token);
    console.log('[/api/auth/me] All cookies:', Object.keys(req.cookies || {}));
    
    if (!token) return res.status(401).json({ error: "Not logged in" });

    const payload = jwt.verify(token, SECRET); // throws if expired/invalid
    console.log('[/api/auth/me] Token payload:', payload);

    const { rows, rowCount } = await query(
      "SELECT id, email, first_name, last_name, org_id, deactivated_at, rate_limit, send_error_alerts, allow_ip_whitelist, profile_picture FROM users WHERE id=$1",
      [payload.id]
    );
    if (!rowCount) return res.status(401).json({ error: "Unknown user" });

    const u = rows[0];
    console.log('[/api/auth/me] User found:', u.email);
    res.json({
      ok: true,
      user: { 
        id: u.id, 
        email: u.email, 
        firstName: u.first_name, 
        lastName: u.last_name,
        deactivatedAt: u.deactivated_at,
        rateLimit: u.rate_limit || 1000,
        sendErrorAlerts: u.send_error_alerts !== false,
        allowIpWhitelist: u.allow_ip_whitelist || false,
        profilePicture: u.profile_picture || null
      }
    });
  } catch (e) {
    console.error('[/api/auth/me] Error:', e.message);
    return res.status(401).json({ error: "Session expired" });
  }
});

// GET /api/auth/debug
// Lightweight debug endpoint to inspect cookie/session status (dev use)
router.get('/debug', (req, res) => {
  const hasPrimary = !!req.cookies?.token;
  const hasLax = !!req.cookies?.token_lax;
  const token = req.cookies?.token || req.cookies?.token_lax;
  const source = req.cookies?.token ? 'token' : (req.cookies?.token_lax ? 'token_lax' : null);
  let tokenValid = false;
  let payload = null;
  try {
    if (token) {
      payload = jwt.verify(token, SECRET);
      tokenValid = true;
    }
  } catch (_) {
    tokenValid = false;
    payload = null;
  }

  res.json({
    ok: true,
    cookies: Object.keys(req.cookies || {}),
    hasToken: !!token,
    hasTokenPrimary: hasPrimary,
    hasTokenLax: hasLax,
    tokenSource: source,
    tokenValid,
    tokenPayload: tokenValid ? payload : null,
    nodeEnv: process.env.NODE_ENV,
    origin: req.headers.origin || null,
  });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * POST /api/auth/profile/avatar
 * Upload profile avatar (multipart/form-data)
 */
router.post('/profile/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Convert to data URL and save in users.profile_picture
    const mime = req.file.mimetype || 'image/png';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    await query(
      `UPDATE users SET profile_picture=$1, updated_at=now() WHERE id=$2`,
      [dataUrl, userId]
    );

    await audit(req, {
      userId,
      action: 'PROFILE_PICTURE_UPDATED',
      targetType: 'user',
      targetId: userId,
      statusCode: 200
    });

    res.json({ ok: true, profilePicture: dataUrl });
  } catch (err) {
    console.error('Failed to upload avatar:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile
 */
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { firstName, lastName, email, rateLimit, sendErrorAlerts, allowIpWhitelist, profilePicture } = req.body;

    // If email is being changed, check if it's already in use
    if (email) {
      const existing = await query(
        "SELECT id FROM users WHERE email=$1 AND id!=$2",
        [email, userId]
      );
      if (existing.rowCount > 0) {
        return res.status(400).json({ error: "Email already in use" });
      }
    }

    // Update user profile
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (firstName !== undefined) {
      updates.push(`first_name=$${paramCount++}`);
      values.push(firstName);
    }
    if (lastName !== undefined) {
      updates.push(`last_name=$${paramCount++}`);
      values.push(lastName);
    }
    if (email !== undefined) {
      updates.push(`email=$${paramCount++}`);
      values.push(email);
    }
    if (rateLimit !== undefined) {
      const limit = parseInt(rateLimit);
      if (isNaN(limit) || limit < 1 || limit > 100000) {
        return res.status(400).json({ error: "Rate limit must be between 1 and 100,000" });
      }
      updates.push(`rate_limit=$${paramCount++}`);
      values.push(limit);
    }
    if (sendErrorAlerts !== undefined) {
      updates.push(`send_error_alerts=$${paramCount++}`);
      values.push(Boolean(sendErrorAlerts));
    }
    if (allowIpWhitelist !== undefined) {
      updates.push(`allow_ip_whitelist=$${paramCount++}`);
      values.push(Boolean(allowIpWhitelist));
    }
    if (profilePicture !== undefined) {
      updates.push(`profile_picture=$${paramCount++}`);
      values.push(profilePicture); // base64 string or null
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(userId);
    await query(
      `UPDATE users SET ${updates.join(", ")}, updated_at=now() WHERE id=$${paramCount}`,
      values
    );

    await audit(req, {
      userId,
      action: "PROFILE_UPDATED",
      targetType: "user",
      targetId: userId,
      statusCode: 200
    });

    res.json({ ok: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Failed to update profile:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/deactivate
 * Deactivate user account (30-day grace period)
 */
router.post("/deactivate", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    // Set deactivation timestamp
    await query(
      "UPDATE users SET deactivated_at=now(), updated_at=now() WHERE id=$1",
      [userId]
    );

    await audit(req, {
      userId,
      action: "ACCOUNT_DEACTIVATED",
      targetType: "user",
      targetId: userId,
      statusCode: 200,
      metadata: { gracePeriodDays: 30 }
    });

    res.json({ 
      ok: true, 
      message: "Account deactivated. You have 30 days to reactivate by logging in again.",
      deactivatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to deactivate account:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/reactivate
 * Reactivate a deactivated account
 */
router.post("/reactivate", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    // Check if account is deactivated
    const user = await query(
      "SELECT deactivated_at FROM users WHERE id=$1",
      [userId]
    );

    if (user.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const deactivatedAt = user.rows[0].deactivated_at;
    if (!deactivatedAt) {
      return res.status(400).json({ error: "Account is not deactivated" });
    }

    // Check if within 30-day grace period
    const daysSinceDeactivation = (Date.now() - new Date(deactivatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDeactivation > 30) {
      return res.status(400).json({ error: "Grace period expired. Account cannot be reactivated." });
    }

    // Reactivate account
    await query(
      "UPDATE users SET deactivated_at=NULL, updated_at=now() WHERE id=$1",
      [userId]
    );

    await audit(req, {
      userId,
      action: "ACCOUNT_REACTIVATED",
      targetType: "user",
      targetId: userId,
      statusCode: 200
    });

    res.json({ ok: true, message: "Account reactivated successfully" });
  } catch (error) {
    console.error("Failed to reactivate account:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/test-error-notification
 * Test endpoint to verify error notification system
 */
router.post("/test-error-notification", async (req, res) => {
  try {
    // Extract and verify JWT token from cookies
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ error: "Not authenticated - no token found" });
    }

    const SECRET = process.env.JWT_SECRET || "supersecret";
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = payload.id;
    if (!userId) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // Send a test error notification
    await sendErrorAlert(userId, {
      type: 'TEST_ERROR',
      message: 'This is a test error notification to verify the system is working correctly.',
      flowName: 'Test Flow',
      executionId: 'test-execution-id',
      metadata: {
        testField: 'This is a test',
        timestamp: new Date().toISOString()
      }
    });

    res.json({ 
      ok: true, 
      message: "Test error notification sent! Check your email if 'Send error alerts' is enabled in settings." 
    });
  } catch (error) {
    console.error("Failed to send test notification:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auth/debug
 * Debug endpoint to verify IP and cookie setup for any user
 */
router.get("/debug", async (req, res) => {
  try {
    const IS_PROD = process.env.NODE_ENV === "production";
    
    // Get client IP from various sources
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const reqIp = req.ip;
    const remoteAddr = req.connection?.remoteAddress || req.socket?.remoteAddress;
    
    const clientIp = (
      forwardedFor?.split(',')[0].trim() ||
      realIp ||
      reqIp ||
      remoteAddr
    );
    
    // Normalize IPv6
    const normalizedIp = clientIp === '::1' || clientIp === '::ffff:127.0.0.1' 
      ? '127.0.0.1' 
      : (clientIp || '').replace(/^::ffff:/, '');
    
    // Cookie info
    const hasCookie = !!req.cookies?.token;
    const cookieCount = Object.keys(req.cookies || {}).length;
    
    // Origin info
    const origin = req.headers.origin || req.headers.referer || 'N/A';
    const host = req.headers.host;
    
    res.json({
      ok: true,
      environment: IS_PROD ? 'production' : 'development',
      cookieSettings: {
        sameSite: IS_PROD ? 'lax' : 'none',
        secure: IS_PROD,
        httpOnly: true,
        path: '/'
      },
      ipDetection: {
        clientIp: normalizedIp,
        sources: {
          'x-forwarded-for': forwardedFor || null,
          'x-real-ip': realIp || null,
          'req.ip': reqIp || null,
          'remoteAddress': remoteAddr || null
        }
      },
      cookies: {
        hasAuthToken: hasCookie,
        totalCookies: cookieCount,
        cookieNames: Object.keys(req.cookies || {})
      },
      request: {
        origin,
        host,
        method: req.method,
        authenticated: !!req.user
      },
      cors: {
        trustProxy: req.app.get('trust proxy'),
        message: 'Dev mode allows all local IPs (192.168.x.x) and configured origins'
      }
    });
  } catch (error) {
    console.error("Debug endpoint error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
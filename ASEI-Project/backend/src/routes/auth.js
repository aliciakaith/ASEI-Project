import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { Issuer, generators } from "openid-client";


const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";

// 🔹 Signup
router.post("/signup", async (req, res) => {
  const { email, password, orgName, firstName, lastName } = req.body;

  try {
    // Ensure org exists
    const orgResult = await query("SELECT id FROM organizations WHERE name=$1", [orgName || "DefaultOrg"]);
    let orgId;
    if (orgResult.rowCount === 0) {
      const newOrg = await query(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        [orgName || "DefaultOrg"]
      );
      orgId = newOrg.rows[0].id;
    } else {
      orgId = orgResult.rows[0].id;
    }

    // ✅ Check for duplicate email BEFORE inserting
    const existing = await query("SELECT 1 FROM users WHERE email=$1", [email.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: "Email already exists. Try logging in instead." });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Insert user
    const result = await query(
      `INSERT INTO users (org_id, email, first_name, last_name, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, org_id`,
      [orgId, email.toLowerCase(), firstName || null, lastName || null, hashed]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error("Signup error:", err);

    // Optional: catch database uniqueness error if constraint is set
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already exists" });
    }

    res.status(500).json({ error: "Server error" });
  }
});

// 🔹 Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await query("SELECT * FROM users WHERE email=$1", [email]);
    if (result.rowCount === 0) return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email, org: user.org_id },
      SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false   // ✅ set true in production (HTTPS)
    });
    res.json({ message: "Logged in" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🔹 Current user
router.get("/me", (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });

  try {
    const user = jwt.verify(token, SECRET);
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// ========== GOOGLE OAUTH ==========

let googleClientPromise;
async function getGoogleClient() {
  if (!googleClientPromise) {
    googleClientPromise = (async () => {
      const google = await Issuer.discover("https://accounts.google.com");
      return new google.Client({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uris: [process.env.GOOGLE_REDIRECT_URI],
        response_types: ["code"],
      });
    })();
  }
  return googleClientPromise;
}

// Step 1: redirect to Google
router.get("/google", async (req, res) => {
  const client = await getGoogleClient();
  const state = generators.state();
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);

  res.cookie("g_state", JSON.stringify({ state, code_verifier }), {
    httpOnly: true,
    sameSite: "lax",
    secure: false
  });

  const url = client.authorizationUrl({
    scope: "openid email profile",
    state,
    code_challenge,
    code_challenge_method: "S256",
  });

  res.redirect(url);
});

router.use((req, _res, next) => {
  if (req.path.startsWith("/google")) {
    console.log("GOOGLE AUTH HIT:", req.method, req.originalUrl);
  }
  next();
});

// Step 2: callback from Google
router.get("/google/callback", async (req, res) => {
  try {
    const client = await getGoogleClient();

    // 1) read and validate state from cookie
    const saved = req.cookies?.g_state ? JSON.parse(req.cookies.g_state) : {};
    const { state: expectedState, code_verifier } = saved;
    const { state, code } = req.query;

    if (!state || state !== expectedState) {
      return res.status(400).send("State mismatch");
    }

    // 2) exchange code for tokens
    const tokenSet = await client.callback(
    process.env.GOOGLE_REDIRECT_URI,
    { code, state },
    { state: expectedState, code_verifier }   // ✅ include expected state
    );
    const claims = tokenSet.claims(); // { email, given_name, family_name, sub, ... }

    if (!claims.email) {
      return res.status(400).send("Google did not provide an email");
    }

    // 3) ensure org exists
    const orgRes = await query("SELECT id FROM organizations WHERE name=$1", ["DefaultOrg"]);
    const orgId = orgRes.rowCount
      ? orgRes.rows[0].id
      : (await query(
          "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
          ["DefaultOrg"]
        )).rows[0].id;

    // 4) upsert user by email
    const existing = await query("SELECT * FROM users WHERE email=$1", [claims.email]);
    let user;
    if (existing.rowCount) {
      user = existing.rows[0];
    } else {
      const created = await query(
        `INSERT INTO users (org_id, email, first_name, last_name, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, first_name, last_name, org_id`,
        [
          orgId,
          claims.email,
          claims.given_name || null,
          claims.family_name || null,
          // random hash since SSO users don't have a local password
          await bcrypt.hash(generators.nonce(), 10)
        ]
      );
      user = created.rows[0];
    }

    // 5) issue JWT like /login
    const token = jwt.sign(
      { id: user.id, email: user.email, org: user.org_id },
      SECRET,
      { expiresIn: "1h" }
    );
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false
    });

    // 6) clean up temp state cookie and redirect to your app
    res.clearCookie("g_state");
    return res.redirect("http://localhost:3000/asei_dashboard.html");
  } catch (err) {
    console.error("Google OAuth error:", err);
    // Helpful during dev to see the actual reason
    res.status(500).send(
      `<pre style="white-space:pre-wrap">${err?.message || err}</pre>`
    );
  }
});


export default router;   // 👈 stays last


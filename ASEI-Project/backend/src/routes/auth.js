import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";

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

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Insert user
    const result = await query(
      `INSERT INTO users (org_id, email, first_name, last_name, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, org_id`,
      [orgId, email, firstName || null, lastName || null, hashed]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error("Signup error:", err);
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

    res.cookie("token", token, { httpOnly: true, sameSite: "lax", secure: false });
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

export default router;

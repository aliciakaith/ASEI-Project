// src/routes/dashboard.js
import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
// import { query } from "../db/postgres.js"; // use later when you connect DB

const router = express.Router();

// GET /api/me  (protected)
router.get("/me", requireAuth, (req, res) => {
  // Assuming your auth middleware sets req.user
  const { id, firstName, lastName, email } = req.user || {
    id: "u1", firstName: "AC", lastName: "Student", email: "user@example.com"
  };
  res.json({ id, firstName, lastName, email });
});

// GET /api/kpis  (protected)
router.get("/kpis", requireAuth, async (_req, res) => {
  // TODO: replace placeholders with real queries
  res.json({
    activeFlows: 12,
    transactions: 1500,
    errors: 3,
    avgLatencyMs: 120,
  });
});

// GET /api/transactions/series  (protected)
router.get("/transactions/series", requireAuth, async (_req, res) => {
  const points = Array.from({ length: 24 }, (_, i) => ({
    t: i,
    count: Math.floor(200 + Math.random() * 300),
  }));
  res.json({ points });
});

// In-memory integrations for now (swap to DB later)
const integrations = [
  { id: "1", name: "MTN Mobile Money", status: "active" },
  { id: "2", name: "Airtel",           status: "pending" },
];

router.get("/integrations", requireAuth, (_req, res) => res.json(integrations));

router.post("/integrations", requireAuth, express.json(), (req, res) => {
  const { name, apiKey } = req.body || {};
  if (!name || !apiKey) return res.status(400).json({ error: "name and apiKey required" });
  integrations.push({ id: String(Date.now()), name, status: "pending" });
  res.status(201).json({ ok: true });
});

export default router;

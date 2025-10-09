// src/routes/dashboard.js
import express from "express";
import { query } from "../db/postgres.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(requireAuth);

// /api/me – read actual user profile from DB
router.get("/me", async (req, res) => {
  const { id } = req.user; // payload has { id, email, org }
  const { rows, rowCount } = await query(
    'SELECT id, email, first_name AS "firstName", last_name AS "lastName" FROM users WHERE id=$1',
    [id]
  );
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

// /api/kpis – compute from tx_events + flows (last 24h)
router.get("/kpis", async (req, res) => {
  const orgId = req.user.org;
  const sql = `
    WITH last24 AS (
      SELECT * FROM tx_events
      WHERE org_id=$1 AND created_at >= now() - interval '24 hours'
    )
    SELECT
      (SELECT COUNT(*) FROM flows WHERE org_id=$1 AND status='active')::int AS "activeFlows",
      (SELECT COUNT(*) FROM last24)::int                                  AS transactions,
      (SELECT COUNT(*) FROM last24 WHERE success=false)::int              AS errors,
      COALESCE((SELECT ROUND(AVG(latency_ms)) FROM last24),0)::int        AS "avgLatencyMs"
  `;
  const { rows } = await query(sql, [orgId]);
  res.json(rows[0]);
});

// /api/transactions/series – hourly buckets for last 24h
router.get("/transactions/series", async (req, res) => {
  const orgId = req.user.org;
  const sql = `
    WITH w AS (SELECT now() - interval '24 hours' AS start_ts, now() AS end_ts),
    buckets AS (
      SELECT generate_series((SELECT start_ts FROM w), (SELECT end_ts FROM w), interval '1 hour') AS bucket
    ),
    counts AS (
      SELECT date_trunc('hour', created_at) AS bucket, COUNT(*)::int AS c
      FROM tx_events
      WHERE org_id=$1 AND created_at >= (SELECT start_ts FROM w)
      GROUP BY 1
    )
    SELECT extract(epoch from b.bucket)::bigint*1000 AS ts, COALESCE(c.c,0) AS count
    FROM buckets b LEFT JOIN counts c ON c.bucket = date_trunc('hour', b.bucket)
    ORDER BY b.bucket;
  `;
  const { rows } = await query(sql, [orgId]);
  res.json({ points: rows.map(r => ({ t: r.ts, count: r.count })) });
});

// /api/integrations – list from DB
router.get("/integrations", async (req, res) => {
  const orgId = req.user.org;
  const { rows } = await query(
    "SELECT id, name, status FROM integrations WHERE org_id=$1 ORDER BY created_at DESC",
    [orgId]
  );
  res.json(rows);
});

// POST /api/integrations – insert into DB (status starts as 'pending')
router.post("/integrations", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const { name, apiKey } = req.body || {};
  if (!name || !apiKey) return res.status(400).json({ error: "name and apiKey required" });
  const { rows } = await query(
    "INSERT INTO integrations (org_id, name, status) VALUES ($1,$2,'pending') RETURNING id, name, status",
    [orgId, name]
  );
  res.status(201).json(rows[0]);
});

export default router;

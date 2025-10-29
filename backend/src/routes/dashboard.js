// src/routes/dashboard.js
import express from "express";
import { query } from "../db/postgres.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(requireAuth);

// Helper: avoid stale 304s while testing
const noStore = (res) => res.set("Cache-Control", "no-store");

// Helper: emit to this org via Socket.IO (no-op if io not set)
const emitToOrg = (req, event, payload) => {
  const io = req.app.get("io");
  io?.to(`org:${req.user.org}`).emit(event, payload ?? {});
};

// ---------- DEV SEED (remove before prod) ----------
router.post("/dev/seed-demo", async (req, res) => {
  const orgId = req.user.org;

  // 4 active flows
  await query(
    `
    INSERT INTO flows (id, org_id, name, status) VALUES
      (gen_random_uuid(), $1, 'Payments',      'active'),
      (gen_random_uuid(), $1, 'KYC Checks',    'active'),
      (gen_random_uuid(), $1, 'Notifications', 'active'),
      (gen_random_uuid(), $1, 'Reconciler',    'active')
    ON CONFLICT DO NOTHING;
  `,
    [orgId]
  );

  // recent tx events
await query(
  `
  INSERT INTO tx_events (org_id, success, latency_ms, created_at) VALUES
    ($1, true ,120, now() - interval '3 hour'),
    ($1, false,260, now() - interval '2 hour'),
    ($1, true , 95, now() - interval '1 hour'),
    ($1, true , 80, now() - interval '10 minutes')
  ;
  `,
  [orgId]
);


  // notifications
  await query(
    `
    INSERT INTO notifications (org_id, type, title, message) VALUES
      ($1,'info' , 'Welcome',        'Your workspace is ready.'),
      ($1,'warn' , 'High latency',    'Average latency exceeded 200ms in the last hour.'),
      ($1,'error', 'Sandbox failure', 'Payment to sandbox gateway failed (HTTP 500).');
  `,
    [orgId]
  );

  emitToOrg(req, "notifications:update");
  noStore(res);
  res.sendStatus(204);
});

// ---------- Me ----------
router.get("/me", async (req, res) => {
  const { id } = req.user; // jwt payload has { id, email, org }
  const { rows, rowCount } = await query(
    `SELECT id,
            email,
            org_id AS "org",
            first_name AS "firstName",
            last_name  AS "lastName"
     FROM users WHERE id=$1`,
    [id]
  );
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  noStore(res);
  res.json(rows[0]);
});

// ---------- KPIs (last 24h) ----------
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
  noStore(res);
  res.json(rows[0]);
});

// ---------- Transactions series (hourly buckets, last 24h) ----------
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
  noStore(res);
  res.json({ points: rows.map((r) => ({ t: r.ts, count: r.count })) });
});

// ---------- Integrations ----------
router.get("/integrations", async (req, res) => {
  const orgId = req.user.org;
  const { rows } = await query(
    "SELECT id, name, status FROM integrations WHERE org_id=$1 ORDER BY created_at DESC",
    [orgId]
  );
  noStore(res);
  res.json(rows);
});

router.post("/integrations", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const { name, apiKey } = req.body || {};
  if (!name || !apiKey)
    return res.status(400).json({ error: "name and apiKey required" });
  const { rows } = await query(
    "INSERT INTO integrations (org_id, name, status) VALUES ($1,$2,'pending') RETURNING id, name, status",
    [orgId, name]
  );
  noStore(res);
  res.status(201).json(rows[0]);
});

// ---------- Notifications ----------
router.get("/notifications", async (req, res) => {
  const orgId = req.user.org;
  const unread = req.query.unread === "1";
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);

  const { rows } = await query(
    `
    SELECT id,
           type,
           title,
           message,
           is_read AS "isRead",
           EXTRACT(EPOCH FROM created_at)*1000 AS ts
    FROM notifications
    WHERE org_id = $1
      AND ($2::boolean IS DISTINCT FROM TRUE OR NOT is_read)
    ORDER BY created_at DESC
    LIMIT $3
  `,
    [orgId, unread, limit]
  );

  noStore(res);
  res.json(rows);
});

router.post("/notifications/:id/read", async (req, res) => {
  await query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND org_id = $2", [
    Number(req.params.id),
    req.user.org,
  ]);
  emitToOrg(req, "notifications:update");
  noStore(res);
  res.sendStatus(204);
});

router.post("/notifications/read-all", async (req, res) => {
  await query("UPDATE notifications SET is_read = TRUE WHERE org_id = $1", [
    req.user.org,
  ]);
  emitToOrg(req, "notifications:update");
  noStore(res);
  res.sendStatus(204);
});

export default router;

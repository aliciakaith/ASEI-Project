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

// Helper: create a notification row and notify the org via socket
async function createNotification(req, { type = 'info', title = '', message = '', related_id = null }) {
  try {
    const orgId = req.user?.org;
    if (!orgId) return;
    await query(
      `INSERT INTO notifications (org_id, type, title, message, related_id) VALUES ($1,$2,$3,$4,$5)`,
      [orgId, type, title, message, related_id]
    );
    emitToOrg(req, 'notifications:update');
  } catch (err) {
    // don't crash the caller flow for non-critical notif write failures
    console.warn('createNotification failed', err);
  }
}

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
  // Insert demo notifications only if an identical notification doesn't already exist
  await query(
    `
    INSERT INTO notifications (org_id, type, title, message)
    SELECT $1, 'info', 'Welcome', 'Your workspace is ready.'
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications WHERE org_id=$1 AND title='Welcome' AND message='Your workspace is ready.'
    );

    INSERT INTO notifications (org_id, type, title, message)
    SELECT $1, 'warn', 'High latency', 'Average latency exceeded 200ms in the last hour.'
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications WHERE org_id=$1 AND title='High latency' AND message='Average latency exceeded 200ms in the last hour.'
    );

    INSERT INTO notifications (org_id, type, title, message)
    SELECT $1, 'error', 'Sandbox failure', 'Payment to sandbox gateway failed (HTTP 500).'
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications WHERE org_id=$1 AND title='Sandbox failure' AND message='Payment to sandbox gateway failed (HTTP 500).'
    );
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

// Replace your current POST /integrations with this
router.post("/integrations", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const { name, apiKey, testUrl } = req.body || {}; // testUrl optional
  if (!name || !apiKey) return res.status(400).json({ error: "name and apiKey required" });

  // store initial row as 'pending' while we verify
  const { rows: insertRows } = await query(
    "INSERT INTO integrations (org_id, name, status, test_url, created_at) VALUES ($1,$2,'pending',$3, now()) RETURNING id, name, status, test_url",
    [orgId, name, testUrl || null]
  );
  const created = insertRows[0];

  // Do an immediate verification attempt (best-effort)
  (async function verifyIntegration(integrationId, name, apiKey, testUrl) {
    // choose a test endpoint:
    // if client supplied testUrl use it, otherwise try some sensible defaults per known providers.
    let url = testUrl || null;
    const lower = (name || "").toLowerCase();

    if (!url) {
      if (/stripe/.test(lower)) url = "https://api.stripe.com/v1/charges?limit=1";
      if (/kora|paylink|finremit|paylink/.test(lower)) url = "https://httpbin.org/get"; // replace with actual provider docs
      if (!url) url = null; // fallback to error/pending handling below
    }

    // If we have no url to call, mark as pending and return
    if (!url) {
      // keep as pending, let manual verify occur later
      emitToOrg(req, "integrations:update");
      return;
    }

    // Attempt a call with short timeout
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000); // 6s
      // choose header scheme: try common patterns
      const headers = {};
      // If looks like Stripe key, stripe uses Basic auth with key:
      if (/^sk_|^pk_/.test(apiKey)) {
        // Stripe: Basic auth with key as username, password empty
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else {
        // generic: try Authorization: Bearer, and also x-api-key
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
      }

      const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);

      // treat 2xx as success
      if (r.ok) {
        await query("UPDATE integrations SET status='active', last_checked=now() WHERE id=$1 AND org_id=$2", [integrationId, orgId]);
        // notify org that integration became active
        await createNotification(req, {
          type: 'info',
          title: `Integration active: ${name}`,
          message: `${name} verified successfully and is now active.`
        });
      } else {
        // non-2xx -> error
        await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2", [integrationId, orgId]);
        await createNotification(req, {
          type: 'error',
          title: `Integration error: ${name}`,
          message: `Verification failed for ${name} (status ${r.status}).`
        });
      }
    } catch (err) {
      // network, timeout, DNS -> error
      await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2", [integrationId, orgId]);
      await createNotification(req, {
        type: 'error',
        title: `Integration error: ${name}`,
        message: `Verification failed for ${name}: ${String(err.message || err)}`
      });
    } finally {
      emitToOrg(req, "integrations:update");
    }
  })(created.id, name, apiKey, created.test_url);

  noStore(res);
  // return pending immediately; client will get update via socket when finished
  return res.status(201).json(created);
});

// Optional manual verify endpoint (retry verification)
router.post("/integrations/:id/verify", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const id = Number(req.params.id);
  // fetch stored integration (including test_url)
  const { rows } = await query("SELECT id, name, test_url FROM integrations WHERE id=$1 AND org_id=$2", [id, orgId]);
  if (!rows.length) return res.status(404).json({ error: "not found" });

  // you should securely retrieve apiKey from your secret store — for demo we assume it's stored (not recommended)
  // For demo: client supplies apiKey in body to retry (safer than storing plaintext): { apiKey: '...' }
  const apiKey = req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: "apiKey required to verify" });

  // mark pending then call the same verification flow as above
  await query("UPDATE integrations SET status='pending' WHERE id=$1 AND org_id=$2", [id, orgId]);
  emitToOrg(req, "integrations:update");

  (async function verify() {
    let testUrl = rows[0].test_url;
    const lower = (rows[0].name || "").toLowerCase();

    if (!testUrl) {
      if (/stripe/.test(lower)) testUrl = "https://api.stripe.com/v1/charges?limit=1";
      if (!testUrl) testUrl = "https://httpbin.org/get";
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const headers = { 'Authorization': `Bearer ${apiKey}`, 'x-api-key': apiKey };
      const r = await fetch(testUrl, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);
      if (r.ok) await query("UPDATE integrations SET status='active', last_checked=now() WHERE id=$1 AND org_id=$2", [id, orgId]);
      else       await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2", [id, orgId]);
      // create notifications for manual verify path as well
      if (r.ok) {
        await createNotification(req, { type: 'info', title: `Integration active: ${rows[0].name}`, message: `${rows[0].name} verified successfully.` });
      } else {
        await createNotification(req, { type: 'error', title: `Integration error: ${rows[0].name}`, message: `Verification failed for ${rows[0].name} (status ${r.status}).` });
      }
    } catch {
      await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2", [id, orgId]);
      await createNotification(req, { type: 'error', title: `Integration error: ${rows[0].name}`, message: `Verification failed for ${rows[0].name}: network/timeout.` });
    } finally {
      emitToOrg(req, "integrations:update");
    }
  })();

  noStore(res);
  res.sendStatus(202); // accepted - verifying async
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

// src/routes/dashboard.js
import express from "express";
import { query } from "../db/postgres.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import fs from "fs";
import path from "path";
import { sendMail } from "../mailer.js";

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


// ---------- Compliance report generation ----------
router.post("/compliance/generate", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const { reportType = 'Integration Summary', recipientEmail } = req.body || {};
  if (!recipientEmail) return res.status(400).json({ error: 'recipientEmail required' });

  try {
    // Build report pieces - use 7 days for more meaningful data
    const kpisSql = `
      WITH last7d AS (
        SELECT * FROM tx_events
        WHERE org_id=$1 AND created_at >= now() - interval '7 days'
      )
      SELECT
        (SELECT COUNT(*) FROM flows WHERE org_id=$1 AND status='active')::int AS "activeFlows",
        (SELECT COUNT(*) FROM last7d)::int                                  AS transactions,
        (SELECT COUNT(*) FROM last7d WHERE success=false)::int              AS errors,
        COALESCE((SELECT ROUND(AVG(latency_ms)) FROM last7d),0)::int        AS "avgLatencyMs"
    `;
    const { rows: kRows } = await query(kpisSql, [orgId]);
    const kpis = kRows[0] || {};

    const { rows: integrations } = await query(
      `SELECT id, name, status, last_checked AS "lastChecked", test_url FROM integrations WHERE org_id=$1 ORDER BY created_at DESC`,
      [orgId]
    );

    // Filter notifications - for security audits, exclude demo/operational noise
    const notifFilter = reportType === 'Security Audit' 
      ? `AND type IN ('error', 'warn') AND title NOT ILIKE '%demo%' AND title NOT ILIKE '%welcome%'`
      : '';
    const { rows: notifications } = await query(
      `SELECT id, type, title, message, is_read AS "isRead", FLOOR(EXTRACT(EPOCH FROM created_at)*1000)::bigint AS ts FROM notifications WHERE org_id=$1 ${notifFilter} ORDER BY created_at DESC LIMIT 100`,
      [orgId]
    );

    const { rows: txEvents } = await query(
      `SELECT success, latency_ms AS "latencyMs", FLOOR(EXTRACT(EPOCH FROM created_at)*1000)::bigint AS ts FROM tx_events WHERE org_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [orgId]
    );

    // Security findings assessment
    const findings = [];
    const isSecurityAudit = reportType === 'Security Audit';

    if (isSecurityAudit) {
      // Check 1: Inactive/error integrations
      const badIntegrations = integrations.filter(i => i.status === 'error' || i.status === 'pending');
      if (badIntegrations.length > 0) {
        findings.push({
          severity: 'medium',
          category: 'Integration Health',
          issue: `${badIntegrations.length} integration(s) in error/pending state`,
          recommendation: 'Review API keys and connectivity for: ' + badIntegrations.map(i => i.name).join(', ')
        });
      }

      // Check 2: High error rate
      const errorRate = kpis.transactions > 0 ? (kpis.errors / kpis.transactions * 100) : 0;
      if (errorRate > 5) {
        findings.push({
          severity: 'high',
          category: 'Transaction Reliability',
          issue: `Error rate is ${errorRate.toFixed(1)}% (${kpis.errors}/${kpis.transactions})`,
          recommendation: 'Investigate failed transactions and implement retry logic'
        });
      }

      // Check 3: Missing test URLs
      const noTestUrl = integrations.filter(i => !i.test_url);
      if (noTestUrl.length > 0) {
        findings.push({
          severity: 'low',
          category: 'Configuration',
          issue: `${noTestUrl.length} integration(s) without test URL`,
          recommendation: 'Add test URLs for health checks: ' + noTestUrl.map(i => i.name).join(', ')
        });
      }

      // Check 4: SMTP config
      if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        findings.push({
          severity: 'medium',
          category: 'Infrastructure',
          issue: 'SMTP not fully configured',
          recommendation: 'Configure SMTP_HOST, SMTP_USER, SMTP_PASS for email notifications'
        });
      }

      // Check 5: High latency
      if (kpis.avgLatencyMs > 500) {
        findings.push({
          severity: 'medium',
          category: 'Performance',
          issue: `Average latency is ${kpis.avgLatencyMs}ms (target: <500ms)`,
          recommendation: 'Optimize slow API calls and add caching where appropriate'
        });
      }

      // Check 6: Recent error notifications
      const recentErrors = notifications.filter(n => n.type === 'error');
      if (recentErrors.length > 3) {
        findings.push({
          severity: 'high',
          category: 'System Stability',
          issue: `${recentErrors.length} error notifications in last 7 days`,
          recommendation: 'Review error logs and implement fixes for recurring issues'
        });
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      org: orgId,
      reportType,
      kpis,
      integrations,
      notifications,
      txEvents,
      findings: isSecurityAudit ? findings : undefined,
    };

    // Persist report to backend/data/compliance_reports
    const dataDir = path.join(process.cwd(), 'data', 'compliance_reports');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    const filename = `${String(orgId).replace(/[^a-zA-Z0-9_-]/g,'')}_${Date.now()}.json`;
    const filepath = path.join(dataDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf8');

    // Build prettier email HTML
    const sevColor = (s) => ({ high: '#dc2626', medium: '#f59e0b', low: '#6b7280' }[s] || '#6b7280');
    const findingsTable = findings.length > 0 ? `
      <h3 style="margin-top:20px;font-size:16px;color:#111827">Security Findings (${findings.length})</h3>
      <table style="width:100%;border-collapse:collapse;margin-top:10px">
        <thead>
          <tr style="background:#f3f4f6;text-align:left">
            <th style="padding:8px;border:1px solid #d1d5db">Severity</th>
            <th style="padding:8px;border:1px solid #d1d5db">Category</th>
            <th style="padding:8px;border:1px solid #d1d5db">Issue</th>
            <th style="padding:8px;border:1px solid #d1d5db">Recommendation</th>
          </tr>
        </thead>
        <tbody>
          ${findings.map(f => `
            <tr>
              <td style="padding:8px;border:1px solid #d1d5db;color:${sevColor(f.severity)};font-weight:600">${f.severity.toUpperCase()}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${f.category}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${f.issue}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${f.recommendation}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '';

    const emailHtml = `
      <div style="font-family:Inter,Arial,sans-serif;padding:20px;background:#f9fafb;color:#111827">
        <h2 style="margin:0 0 10px;color:#111827">Compliance Report: ${reportType}</h2>
        <p style="margin:0 0 16px;color:#6b7280;font-size:14px">Generated ${new Date().toLocaleString()} for org ${orgId}</p>
        
        <h3 style="margin-top:20px;font-size:16px;color:#111827">Summary (Last 7 Days)</h3>
        <ul style="margin:10px 0;padding-left:20px;line-height:1.6">
          <li><strong>Active Flows:</strong> ${kpis.activeFlows}</li>
          <li><strong>Transactions:</strong> ${kpis.transactions} (${kpis.errors} errors)</li>
          <li><strong>Avg Latency:</strong> ${kpis.avgLatencyMs}ms</li>
          <li><strong>Integrations:</strong> ${integrations.length} total (${integrations.filter(i => i.status === 'active').length} active)</li>
        </ul>

        ${findingsTable}

        <p style="margin-top:20px;font-size:12px;color:#6b7280">Full report attached as JSON and PDF.</p>
      </div>
    `;

    // Send email with attachment
    try {
      await sendMail({
        to: recipientEmail,
        subject: `Compliance report (${reportType}) - ${new Date().toLocaleString()}`,
        text: `Attached is the compliance report (${reportType}). Findings: ${findings.length}`,
        html: emailHtml,
        attachments: [
          { filename: `compliance-${Date.now()}.json`, content: JSON.stringify(report, null, 2) }
        ]
      });
    } catch (mailErr) {
      // If email fails, still return the report but inform the caller
      await query(
        `INSERT INTO notifications (org_id, type, title, message) VALUES ($1, 'warn', 'Compliance: email failed', $2)`,
        [orgId, `Failed to send compliance report to ${recipientEmail}: ${String(mailErr.message || mailErr)}`]
      ).catch(()=>{});

      return res.status(502).json({ error: 'email_failed', message: String(mailErr.message || mailErr), report });
    }

    // Notification for org
    await query(`INSERT INTO notifications (org_id, type, title, message) VALUES ($1, 'info', 'Compliance generated', $2)`, [orgId, `Compliance report (${reportType}) generated and emailed to ${recipientEmail}`]).catch(()=>{});
    emitToOrg(req, 'notifications:update');

    noStore(res);
    res.json({ ok: true, emailedTo: recipientEmail, report });
  } catch (err) {
    console.error('Compliance generate failed', err && err.stack ? err.stack : err);
    res.status(500).json({ error: String(err.message || err) });
  }
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
    `SELECT id, name, status, last_checked AS "lastChecked"
     FROM integrations
     WHERE org_id=$1
     ORDER BY created_at DESC`,
    [orgId]
  );
  noStore(res);
  res.json(rows);
});


router.post("/integrations", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const { name, apiKey, testUrl } = req.body || {};
  if (!name || !apiKey) return res.status(400).json({ error: "name and apiKey required" });

  // Insert as PENDING with current timestamp and return immediately
  const { rows: insertRows } = await query(
    `INSERT INTO integrations (org_id, name, status, test_url, created_at, last_checked)
     VALUES ($1, $2, 'pending', $3, now(), now())
     RETURNING id, name, status, test_url, last_checked`,
    [orgId, name, testUrl || null]
  );
  const created = insertRows[0];

  noStore(res);
  res.status(201).json(created);

  // Kick off delayed verification (no await)
  verifyAfterDelay({
    req, orgId,
    integrationId: created.id,
    name,
    apiKey,
    testUrl: created.test_url
  });
});




 const VERIFY_DELAY_MS = 3000; // 3 seconds

async function verifyAfterDelay({ req, orgId, integrationId, name, apiKey, testUrl }) {
  // wait a bit so UI shows "Pending"
  await new Promise(r => setTimeout(r, VERIFY_DELAY_MS));

  // Pick a URL: user-supplied first, else some sensible defaults
  let url = testUrl || null;
  const lower = (name || "").toLowerCase();
  if (!url) {
    if (/stripe/.test(lower)) url = "https://api.stripe.com/v1/charges?limit=1";
    // add more provider heuristics here if you like
  }

  // If we still don't have a URL or it's not a valid URL → error
  try { if (!url) throw new Error("no url"); new URL(url); } catch {
    await query(
      "UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2",
      [integrationId, orgId]
    );
    await createNotification(req, {
      type: 'error',
      title: `Integration error: ${name}`,
      message: `No valid Test URL for "${name}". Add one and click Verify.`
    });
    emitToOrg(req, "integrations:update");
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s network timeout
    const headers = {};

    // Guess common auth styles
    if (/^sk_|^pk_/.test(apiKey)) {
      headers['Authorization'] = `Bearer ${apiKey}`; // Stripe (& many others)
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }

    const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);

    if (r.ok) {
      await query("UPDATE integrations SET status='active', last_checked=now() WHERE id=$1 AND org_id=$2",
        [integrationId, orgId]);
      await createNotification(req, {
        type: 'info',
        title: `Integration active: ${name}`,
        message: `${name} verified successfully.`
      });
    } else {
      await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2",
        [integrationId, orgId]);
      await createNotification(req, {
        type: 'error',
        title: `Integration error: ${name}`,
        message: `Verification failed (HTTP ${r.status}).`
      });
    }
  } catch (err) {
    await query("UPDATE integrations SET status='error', last_checked=now() WHERE id=$1 AND org_id=$2",
      [integrationId, orgId]);
    await createNotification(req, {
      type: 'error',
      title: `Integration error: ${name}`,
      message: `Verification failed: ${String(err.message || err)}`
    });
  } finally {
    emitToOrg(req, "integrations:update");
  }
}

router.post("/integrations/:id/verify", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const id = Number(req.params.id);

  const { rows } = await query(
    "SELECT id, name, test_url FROM integrations WHERE id=$1 AND org_id=$2",
    [id, orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });

  const apiKey = req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: "apiKey required to verify" });

  // show Pending first with current timestamp
  await query("UPDATE integrations SET status='pending', last_checked=now() WHERE id=$1 AND org_id=$2", [id, orgId]);
  emitToOrg(req, "integrations:update");

  noStore(res);
  res.sendStatus(202); // accepted – verifier runs “in background” (in this request cycle)

  // reuse the same delayed verifier
  verifyAfterDelay({
    req,
    orgId,
    integrationId: id,
    name: rows[0].name,
    apiKey,
    testUrl: rows[0].test_url
  });
});


// ---------- Sandbox fetch proxy (for API tester) ----------
router.post("/dev/sandbox/fetch", express.json({ limit: "256kb" }), async (req, res) => {
  const { url, method = "GET", headers = {}, body } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });

  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ error: "invalid url" }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: "only http/https allowed" });

  // Basic SSRF guard (block obvious internal nets). For production, consider DNS re-resolving + CIDR checks.
  const host = u.hostname;
  const blocked = [
    "localhost", "127.0.0.1", "::1",
  ];
  const isPrivate =
    blocked.includes(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host);

  if (isPrivate) return res.status(403).json({ error: "private IPs/hosts are blocked" });

  // Build fetch options
  const opts = { method: String(method || "GET").toUpperCase(), headers: {} };
  // Copy headers but strip hop-by-hop / dangerous ones
  const banned = new Set(["host","connection","content-length","upgrade","accept-encoding","cookie","authorization"]);
  for (const [k, v] of Object.entries(headers || {})) {
    if (!banned.has(String(k).toLowerCase())) opts.headers[k] = v;
  }
  if (body != null && opts.method !== "GET" && opts.method !== "HEAD") {
    if (typeof body === "string") {
      opts.body = body;
      if (!opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    } else {
      opts.body = JSON.stringify(body);
      if (!opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    }
  }

  // Timeout
  const controller = new AbortController();
  const timeoutMs = 10000;
  const to = setTimeout(() => controller.abort(), timeoutMs);
  opts.signal = controller.signal;

  const t0 = Date.now();
  try {
    const r = await fetch(url, opts);
    clearTimeout(to);

    // Cap body size to avoid huge payloads
    const limit = 512 * 1024; // 512 KB
    const buf = Buffer.from(await r.arrayBuffer());
    const truncated = buf.length > limit;
    const bodyBuf = truncated ? buf.subarray(0, limit) : buf;

    // Try to present text; fall back to base64 for binary-ish content
    const ctype = r.headers.get("content-type") || "";
    const isText = /^(text\/|application\/(json|xml|svg|javascript|x-www-form-urlencoded))/.test(ctype);
    const bodyOut = isText ? bodyBuf.toString("utf8") : bodyBuf.toString("base64");
    const encoding = isText ? "utf8" : "base64";

    // Return a compact view of headers
    const hdrs = {};
    r.headers.forEach((v, k) => { hdrs[k] = v; });

    res.json({
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      durationMs: Date.now() - t0,
      headers: hdrs,
      contentType: ctype,
      body: bodyOut,
      encoding,
      truncated
    });
  } catch (err) {
    clearTimeout(to);
    res.status(502).json({ error: String(err.message || err), durationMs: Date.now() - t0 });
  }
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

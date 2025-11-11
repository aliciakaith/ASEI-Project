// src/routes/dashboard.js
import express from "express";
import { query } from "../db/postgres.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import fs from "fs";
import path from "path";
import { sendMail } from "../mailer.js";
import PDFDocument from "pdfkit";

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

  // Remove demo flows - users should create their own flows
  // Flows are now created via the Flow Designer UI

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

    // Extra data for Data Privacy Report
    const { rows: users } = await query(
      `SELECT id, email, first_name AS "firstName", last_name AS "lastName", created_at AS "createdAt" FROM users WHERE org_id=$1`,
      [orgId]
    );
    
    // Guard organizations query (table might not exist in some environments)
    let org = {};
    try {
      const { rows: orgData } = await query(
        `SELECT id, name, created_at AS "createdAt" FROM organizations WHERE id=$1`,
        [orgId]
      );
      org = orgData[0] || {};
    } catch (orgErr) {
      console.warn('Organizations table query failed (table may not exist):', orgErr.message);
      org = { id: orgId, name: 'Unknown', createdAt: null };
    }

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

    // Data Privacy checks (only for Data Privacy Report)
    const privacyChecks = [];
    const isDataPrivacy = reportType === 'Data Privacy Report';
    
    if (isDataPrivacy) {
      // Check 1: PII retention policy
      const oldUsers = users.filter(u => {
        const age = Date.now() - new Date(u.createdAt).getTime();
        return age > 365 * 24 * 60 * 60 * 1000; // older than 1 year
      });
      if (oldUsers.length > 0) {
        privacyChecks.push({
          severity: 'medium',
          category: 'Data Retention',
          issue: `${oldUsers.length} user(s) older than 1 year`,
          recommendation: 'Review data retention policy and purge inactive accounts if appropriate'
        });
      }

      // Check 2: SMTP security (hardened)
      const smtpPort = process.env.SMTP_PORT;
      const smtpPortNum = smtpPort ? parseInt(smtpPort, 10) : undefined;
      if (process.env.SMTP_HOST && process.env.SMTP_HOST.includes('gmail') && smtpPortNum !== 465) {
        privacyChecks.push({
          severity: 'low',
          category: 'Email Security',
          issue: `Gmail SMTP not using SSL port 465 (current: ${smtpPort || 'undefined'})`,
          recommendation: 'Use port 465 with secure=true for Gmail to encrypt email transmission'
        });
      }

      // Check 3: Notifications with PII
      const piiNotifs = notifications.filter(n => 
        /email|phone|ssn|credit/i.test(n.message) || /email|phone|ssn|credit/i.test(n.title)
      );
      if (piiNotifs.length > 0) {
        privacyChecks.push({
          severity: 'high',
          category: 'PII Exposure',
          issue: `${piiNotifs.length} notification(s) may contain PII in messages`,
          recommendation: 'Sanitize notification messages to avoid storing sensitive data in plain text'
        });
      }

      // Check 4: HTTPS enforcement
      const nonHttpsIntegrations = integrations.filter(i => 
        i.test_url && i.test_url.startsWith('http://') && !i.test_url.includes('localhost')
      );
      if (nonHttpsIntegrations.length > 0) {
        privacyChecks.push({
          severity: 'high',
          category: 'Transport Security',
          issue: `${nonHttpsIntegrations.length} integration(s) using HTTP instead of HTTPS`,
          recommendation: 'Enforce HTTPS for all external integrations: ' + nonHttpsIntegrations.map(i => i.name).join(', ')
        });
      }

      // Check 5: PII in URLs (check tx_events metadata for potential PII in URLs)
      const piiInUrls = txEvents.filter(e => 
        e.metadata && typeof e.metadata === 'object' && 
        (e.metadata.url || e.metadata.endpoint) &&
        /email|phone|ssn|credit|password/i.test(e.metadata.url || e.metadata.endpoint || '')
      );
      if (piiInUrls.length > 0) {
        privacyChecks.push({
          severity: 'critical',
          category: 'PII Exposure',
          issue: `${piiInUrls.length} transaction(s) may have PII in URLs/query params`,
          recommendation: 'Never pass sensitive data in URLs—use POST body or headers instead'
        });
      }

      // Check 6: JWT secret strength (conditional severity)
      const jwtSecret = process.env.JWT_SECRET || '';
      if (jwtSecret.length < 32) {
        privacyChecks.push({
          severity: jwtSecret === 'please_change_me' || jwtSecret.length < 16 ? 'critical' : 'high',
          category: 'Authentication Security',
          issue: `JWT secret is weak (${jwtSecret.length} chars, default=${jwtSecret === 'please_change_me'})`,
          recommendation: 'Use a strong random secret (32+ chars) for JWT_SECRET in production'
        });
      }

      // Check 7: User consent tracking
      privacyChecks.push({
        severity: 'medium',
        category: 'Compliance',
        issue: 'No explicit user consent tracking detected',
        recommendation: 'Implement consent management for GDPR/CCPA (terms acceptance, data processing agreements)'
      });

      // Check 8: Data export capability
      privacyChecks.push({
        severity: 'low',
        category: 'User Rights',
        issue: 'No self-service data export endpoint detected',
        recommendation: 'Provide users ability to download their data (GDPR Article 20)'
      });
    }

    // Derived roll-up for easier UI rendering
    const integrationsByStatus = {
      active: integrations.filter(i => i.status === 'active'),
      pending: integrations.filter(i => i.status === 'pending'),
      error: integrations.filter(i => i.status === 'error'),
    };

    const report = {
      generatedAt: new Date().toISOString(),
      org: orgId,
      reportType,
      kpis,
      integrations,
      notifications,
      txEvents,
      findings: isSecurityAudit ? findings : undefined,
      privacyChecks: isDataPrivacy ? privacyChecks : undefined,
      users: isDataPrivacy ? users.map(u => ({ id: u.id, email: u.email, createdAt: u.createdAt })) : undefined,
      orgInfo: isDataPrivacy ? org : undefined,
      summary: {
        totalIntegrations: integrations.length,
        activeIntegrations: integrationsByStatus.active.length,
        pendingIntegrations: integrationsByStatus.pending.length,
        errorIntegrations: integrationsByStatus.error.length,
        errorRate: kpis.transactions > 0 ? ((kpis.errors / kpis.transactions) * 100).toFixed(1) + '%' : '0%',
      }
    };

    // Persist report to backend/data/compliance_reports
    const dataDir = path.join(process.cwd(), 'data', 'compliance_reports');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { void e; }
    const filename = `${String(orgId).replace(/[^a-zA-Z0-9_-]/g,'')}_${Date.now()}.json`;
    const filepath = path.join(dataDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf8');

    // Generate PDF
    const pdfFilename = filename.replace(/\.json$/, '') + '.pdf';
    const pdfPath = path.join(dataDir, pdfFilename);
    try {
      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const out = fs.createWriteStream(pdfPath);
        doc.pipe(out);

        // HEADER - Different colors for each report type
        const headerColor = isSecurityAudit ? '#dc2626' : isDataPrivacy ? '#3b82f6' : '#10b981';
        doc.fillColor(headerColor).fontSize(20).text(`${reportType}`, { align: 'center' });
        doc.fillColor('#000000');
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#6b7280').text(`Generated: ${new Date(report.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`, { align: 'center' });
        doc.text(`Organization ID: ${orgId}`, { align: 'center' });
        doc.moveDown(1.5);

        // REPORT TYPE SPECIFIC INTRO
        if (isSecurityAudit) {
          doc.fillColor(headerColor).fontSize(14).text('🔒 Security Assessment Overview', { underline: true });
          doc.fillColor('#000000').fontSize(10).moveDown(0.3);
          doc.text('This report identifies security risks, misconfigurations, and reliability issues in your integration platform.');
          doc.moveDown(0.8);
        } else if (isDataPrivacy) {
          doc.fillColor(headerColor).fontSize(14).text('🛡️ Data Privacy & Compliance Assessment', { underline: true });
          doc.fillColor('#000000').fontSize(10).moveDown(0.3);
          doc.text('This report evaluates data protection practices, PII handling, and regulatory compliance (GDPR/CCPA).');
          doc.text(`Organization: ${org.name || orgId} | Users: ${users.length} | Created: ${org.createdAt ? new Date(org.createdAt).toLocaleDateString() : 'N/A'}`);
          doc.moveDown(0.8);
        } else {
          doc.fillColor(headerColor).fontSize(14).text('📊 Integration Summary', { underline: true });
          doc.fillColor('#000000').fontSize(10).moveDown(0.3);
          doc.text('This report provides a comprehensive overview of all integrations, their health status, and performance metrics.');
          doc.moveDown(0.8);
        }

        // KPIs Section (common for all)
        doc.fontSize(13).fillColor('#111827').text('Key Performance Indicators (Last 7 Days)', { underline: true });
        doc.fontSize(10).fillColor('#000000').moveDown(0.3);
        
        const kpiY = doc.y;
        doc.rect(50, kpiY, 495, 90).fillAndStroke('#f9fafb', '#d1d5db');
        doc.fillColor('#000000').fontSize(10);
        
        doc.text(`Active Flows: ${kpis.activeFlows}`, 60, kpiY + 10);
        doc.text(`Total Transactions: ${kpis.transactions}`, 60, kpiY + 30);
        doc.text(`Failed Transactions: ${kpis.errors} (${report.summary.errorRate} error rate)`, 60, kpiY + 50);
        doc.text(`Average Latency: ${kpis.avgLatencyMs}ms`, 60, kpiY + 70);
        
        doc.y = kpiY + 100;
        doc.moveDown(0.5);

        // SECURITY AUDIT SPECIFIC CONTENT
        if (isSecurityAudit) {
          doc.addPage();
          doc.fontSize(14).fillColor('#dc2626').text('🔍 Security Findings', { underline: true });
          doc.fillColor('#000000').fontSize(10).moveDown(0.5);
          
          if (findings.length === 0) {
            doc.fillColor('#10b981').text('✓ No critical security issues detected', { align: 'center' });
            doc.fillColor('#000000').moveDown();
          } else {
            const criticalCount = findings.filter(f => f.severity === 'high' || f.severity === 'critical').length;
            doc.text(`Total Findings: ${findings.length} (${criticalCount} high/critical)`);
            doc.moveDown(0.5);
            
            findings.forEach((f, idx) => {
              const sevColor = { high: '#dc2626', critical: '#b91c1c', medium: '#f59e0b', low: '#6b7280' }[f.severity] || '#6b7280';
              doc.fillColor(sevColor).fontSize(11).text(`${idx + 1}. [${f.severity.toUpperCase()}] ${f.category}`, { continued: false });
              doc.fillColor('#000000').fontSize(9);
              doc.text(`   Issue: ${f.issue}`);
              doc.fillColor('#3b82f6').text(`   → ${f.recommendation}`);
              doc.fillColor('#000000').moveDown(0.3);
            });
          }
          
          doc.moveDown(1);
          doc.fontSize(13).text('Integration Health Status', { underline: true });
          doc.fontSize(10).moveDown(0.3);
          doc.fillColor('#10b981').text(`✓ Active: ${integrationsByStatus.active.length} - ${integrationsByStatus.active.map(i => i.name).join(', ') || 'None'}`);
          doc.fillColor('#f59e0b').text(`⚠ Pending: ${integrationsByStatus.pending.length} - ${integrationsByStatus.pending.map(i => i.name).join(', ') || 'None'}`);
          doc.fillColor('#dc2626').text(`✗ Error: ${integrationsByStatus.error.length} - ${integrationsByStatus.error.map(i => i.name).join(', ') || 'None'}`);
          doc.fillColor('#000000');
        }
        
        // DATA PRIVACY SPECIFIC CONTENT
        else if (isDataPrivacy) {
          doc.addPage();
          doc.fontSize(14).fillColor('#3b82f6').text('🛡️ Privacy & Compliance Checks', { underline: true });
          doc.fillColor('#000000').fontSize(10).moveDown(0.5);
          
          if (privacyChecks.length === 0) {
            doc.fillColor('#10b981').text('✓ All privacy checks passed', { align: 'center' });
            doc.fillColor('#000000').moveDown();
          } else {
            const criticalPrivacy = privacyChecks.filter(p => p.severity === 'critical' || p.severity === 'high').length;
            doc.text(`Total Privacy Issues: ${privacyChecks.length} (${criticalPrivacy} critical/high)`);
            doc.moveDown(0.5);
            
            privacyChecks.forEach((p, idx) => {
              const sevColor = { critical: '#b91c1c', high: '#dc2626', medium: '#f59e0b', low: '#6b7280' }[p.severity] || '#6b7280';
              doc.fillColor(sevColor).fontSize(11).text(`${idx + 1}. [${p.severity.toUpperCase()}] ${p.category}`, { continued: false });
              doc.fillColor('#000000').fontSize(9);
              doc.text(`   Issue: ${p.issue}`);
              doc.fillColor('#3b82f6').text(`   → ${p.recommendation}`);
              doc.fillColor('#000000').moveDown(0.3);
            });
          }
          
          doc.moveDown(1);
          doc.fontSize(13).text('Data Protection Summary', { underline: true });
          doc.fontSize(10).moveDown(0.3);
          doc.text(`Total Users: ${users.length}`);
          doc.text(`Users > 1 year old: ${users.filter(u => (Date.now() - new Date(u.createdAt)) > 365*24*60*60*1000).length}`);
          doc.text(`SMTP Security: ${process.env.SMTP_PORT === '465' ? '✓ SSL Enabled' : '⚠ Not using SSL (465)'}`);
          doc.text(`HTTPS Enforcement: ${integrations.filter(i => i.test_url && i.test_url.startsWith('http://') && !i.test_url.includes('localhost')).length === 0 ? '✓ All HTTPS' : '⚠ HTTP detected'}`);
          doc.text(`JWT Secret Strength: ${(process.env.JWT_SECRET?.length || 0) >= 32 ? '✓ Strong (32+ chars)' : '⚠ Weak'}`);
        }
        
        // INTEGRATION SUMMARY SPECIFIC CONTENT
        else {
          doc.fontSize(13).text('Integration Status Breakdown', { underline: true });
          doc.fontSize(10).moveDown(0.5);
          
          // Active integrations
          doc.fillColor('#10b981').fontSize(11).text(`🟢 Active Integrations (${integrationsByStatus.active.length})`, { underline: false });
          doc.fillColor('#000000').fontSize(9);
          if (integrationsByStatus.active.length > 0) {
            integrationsByStatus.active.forEach(i => {
              doc.text(`  • ${i.name} - Last checked: ${i.lastChecked ? new Date(i.lastChecked).toLocaleString() : 'Never'}`);
              if (i.test_url) doc.fillColor('#6b7280').text(`    ${i.test_url}`, { indent: 20 });
              doc.fillColor('#000000');
            });
          } else {
            doc.fillColor('#6b7280').text('  (None)');
            doc.fillColor('#000000');
          }
          doc.moveDown(0.5);
          
          // Pending integrations
          doc.fillColor('#f59e0b').fontSize(11).text(`🟡 Pending Integrations (${integrationsByStatus.pending.length})`, { underline: false });
          doc.fillColor('#000000').fontSize(9);
          if (integrationsByStatus.pending.length > 0) {
            integrationsByStatus.pending.forEach(i => {
              doc.text(`  • ${i.name} - Last checked: ${i.lastChecked ? new Date(i.lastChecked).toLocaleString() : 'Never'}`);
            });
          } else {
            doc.fillColor('#6b7280').text('  (None)');
            doc.fillColor('#000000');
          }
          doc.moveDown(0.5);
          
          // Error integrations
          doc.fillColor('#dc2626').fontSize(11).text(`🔴 Error Integrations (${integrationsByStatus.error.length})`, { underline: false });
          doc.fillColor('#000000').fontSize(9);
          if (integrationsByStatus.error.length > 0) {
            integrationsByStatus.error.forEach(i => {
              doc.text(`  • ${i.name} - Last checked: ${i.lastChecked ? new Date(i.lastChecked).toLocaleString() : 'Never'}`);
            });
          } else {
            doc.fillColor('#6b7280').text('  (None)');
            doc.fillColor('#000000');
          }
          doc.moveDown(1);
          
          // Transaction Performance
          doc.addPage();
          doc.fontSize(13).text('Transaction Performance Analysis', { underline: true });
          doc.fontSize(10).moveDown(0.5);
          doc.text(`Total Transactions (7 days): ${kpis.transactions}`);
          doc.text(`Success Rate: ${kpis.transactions > 0 ? ((1 - kpis.errors / kpis.transactions) * 100).toFixed(1) : 100}%`);
          doc.text(`Average Response Time: ${kpis.avgLatencyMs}ms`);
          doc.text(`Performance Rating: ${kpis.avgLatencyMs < 200 ? '✓ Excellent' : kpis.avgLatencyMs < 500 ? '⚠ Good' : '✗ Needs Improvement'}`);
        }

        // Recent Activity (all reports)
        doc.addPage();
        doc.fontSize(13).fillColor('#111827').text('Recent Notifications', { underline: true });
        doc.fillColor('#000000').fontSize(9).moveDown(0.3);
        
        if (notifications.length === 0) {
          doc.text('No recent notifications');
        } else {
          notifications.slice(0, 15).forEach(n => {
            const typeColor = { error: '#dc2626', warn: '#f59e0b', info: '#3b82f6', success: '#10b981' }[n.type] || '#6b7280';
            doc.fillColor(typeColor).text(`[${n.type.toUpperCase()}]`, { continued: true });
            doc.fillColor('#000000').text(` ${new Date(Number(n.ts)).toLocaleString()} - ${n.title}`);
          });
        }

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#6b7280').text('End of Report', { align: 'center' });

        doc.end();
        out.on('finish', resolve);
        out.on('error', reject);
      });
    } catch (pdfErr) {
      console.warn('PDF generation failed', pdfErr);
    }

    // Build prettier email HTML
    const sevColor = (s) => ({ high: '#dc2626', medium: '#f59e0b', low: '#6b7280' }[s] || '#6b7280');
    
    // Integration breakdown by status (for Integration Summary)
    const integStatusGroups = {
      active: integrations.filter(i => i.status === 'active'),
      pending: integrations.filter(i => i.status === 'pending'),
      error: integrations.filter(i => i.status === 'error'),
    };
    
    const integrationBreakdown = reportType === 'Integration Summary' ? `
      <h3 style="margin-top:20px;font-size:16px;color:#111827">Integration Status Breakdown</h3>
      <div style="margin:10px 0">
        <div style="margin-bottom:8px">
          <span style="color:#10b981;font-weight:600">🟢 Active (${integStatusGroups.active.length})</span>
          ${integStatusGroups.active.length > 0 ? `<div style="margin-left:20px;color:#6b7280;font-size:13px">${integStatusGroups.active.map(i => i.name).join(', ')}</div>` : ''}
        </div>
        <div style="margin-bottom:8px">
          <span style="color:#f59e0b;font-weight:600">🟡 Pending (${integStatusGroups.pending.length})</span>
          ${integStatusGroups.pending.length > 0 ? `<div style="margin-left:20px;color:#6b7280;font-size:13px">${integStatusGroups.pending.map(i => i.name).join(', ')}</div>` : ''}
        </div>
        <div style="margin-bottom:8px">
          <span style="color:#dc2626;font-weight:600">🔴 Error (${integStatusGroups.error.length})</span>
          ${integStatusGroups.error.length > 0 ? `<div style="margin-left:20px;color:#6b7280;font-size:13px">${integStatusGroups.error.map(i => i.name).join(', ')}</div>` : ''}
        </div>
      </div>
    ` : '';
    
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

    const privacyChecksTable = isDataPrivacy && privacyChecks.length > 0 ? `
      <h3 style="margin-top:20px;font-size:16px;color:#111827">Data Privacy Assessment</h3>
      <p style="margin:10px 0;padding:10px;background:#eff6ff;border-left:3px solid #3b82f6;color:#1e40af;font-size:14px">
        <strong>Privacy Summary:</strong> ${privacyChecks.length} check(s) performed on ${users.length} user(s) across ${org.name || orgId}
      </p>
      <div style="margin:10px 0;padding:10px;background:#ffffff;border-left:3px solid #6366f1">
        <p style="margin:0 0 8px;font-weight:600">Organization: ${org.name || orgId}</p>
        <p style="margin:0 0 8px;color:#6b7280">Created: ${org.createdAt ? new Date(org.createdAt).toLocaleDateString() : 'N/A'}</p>
        <p style="margin:0;color:#6b7280">Total Users: ${users.length}</p>
      </div>
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
          ${privacyChecks.map(p => `
            <tr>
              <td style="padding:8px;border:1px solid #d1d5db;color:${sevColor(p.severity)};font-weight:600">${p.severity.toUpperCase()}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${p.category}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${p.issue}</td>
              <td style="padding:8px;border:1px solid #d1d5db">${p.recommendation}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '';

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
    const sydneyDate = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' });

    const emailHtml = `
      <div style="font-family:Inter,Arial,sans-serif;padding:20px;background:#f9fafb;color:#111827">
        <h2 style="margin:0 0 10px;color:#111827">Compliance Report: ${reportType}</h2>
        <p style="margin:0 0 16px;color:#6b7280;font-size:14px">Generated ${sydneyTime} (Sydney) for org ${orgId}</p>
        
        <h3 style="margin-top:20px;font-size:16px;color:#111827">Summary (Last 7 Days)</h3>
        <ul style="margin:10px 0;padding-left:20px;line-height:1.6">
          <li><strong>Active Flows:</strong> ${kpis.activeFlows}</li>
          <li><strong>Transactions:</strong> ${kpis.transactions} (${kpis.errors} errors, ${report.summary.errorRate} error rate)</li>
          <li><strong>Avg Latency:</strong> ${kpis.avgLatencyMs}ms</li>
          <li><strong>Integrations:</strong> ${integrations.length} total (${integStatusGroups.active.length} active)</li>
        </ul>

        ${integrationBreakdown}
        ${findingsTable}
        ${privacyChecksTable}

        <p style="margin-top:20px;font-size:12px;color:#6b7280">Full report attached as JSON and PDF.</p>
      </div>
    `;

    // Send email with attachments (JSON + PDF)
    try {
      const attachments = [ 
        { filename: `compliance-${Date.now()}.json`, content: JSON.stringify(report, null, 2) }
      ];
      if (fs.existsSync(pdfPath)) {
        attachments.push({ filename: `compliance-${Date.now()}.pdf`, path: pdfPath });
      }

      await sendMail({
        to: recipientEmail,
        subject: `Compliance report (${reportType}) - ${sydneyDate}`,
        text: `Attached is the compliance report (${reportType}). ${isSecurityAudit ? `Findings: ${findings.length}` : isDataPrivacy ? `Privacy Checks: ${privacyChecks.length}` : ''}`,
        html: emailHtml,
        attachments
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
            last_name  AS "lastName",
            profile_picture AS "profilePicture"
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




// Update integration (name and/or test_url)
router.patch("/integrations/:id", express.json(), async (req, res) => {
  const orgId = req.user.org;
  const id = req.params.id; // ID is a UUID, not an integer
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid integration ID format' });
  }
  
  const { name, testUrl } = req.body || {};

  const fields = [];
  const values = [];
  let idx = 1;

  if (typeof name === 'string' && name.trim().length) { fields.push(`name=$${idx++}`); values.push(name.trim()); }
  if (typeof testUrl === 'string') { fields.push(`test_url=$${idx++}`); values.push(testUrl || null); }

  if (!fields.length) return res.status(400).json({ error: 'no_updates' });

  // Always bump last_checked so UI reflects recent change
  fields.push(`last_checked=now()`);

  values.push(id, orgId);
  const sql = `UPDATE integrations SET ${fields.join(', ')} WHERE id=$${idx++} AND org_id=$${idx} RETURNING id, name, status, test_url, last_checked AS "lastChecked"`;
  const { rows } = await query(sql, values);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  emitToOrg(req, "integrations:update");
  noStore(res);
  res.json(rows[0]);
});

// Delete integration
router.delete("/integrations/:id", async (req, res) => {
  const orgId = req.user.org;
  const id = req.params.id; // ID is a UUID, not an integer
  
  console.log('Delete integration - orgId:', orgId, 'type:', typeof orgId, 'id:', id);
  
  // Validate that both IDs are valid UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid integration ID format' });
  }
  
  if (!uuidRegex.test(orgId)) {
    console.error('Invalid org_id format:', orgId);
    return res.status(401).json({ error: 'Invalid organization ID. Please log in again.' });
  }
  
  const { rowCount } = await query("DELETE FROM integrations WHERE id=$1 AND org_id=$2", [id, orgId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  emitToOrg(req, "integrations:update");
  noStore(res);
  res.sendStatus(204);
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
  const id = req.params.id; // ID is a UUID, not an integer
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid integration ID format' });
  }

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

// src/routes/flows.js
import express from "express";
import { query } from "../db/postgres.js";
import { audit } from "../logging/audit.js";
import ExecutionService from "../execution/ExecutionService.js";

const router = express.Router();

// Note: Removed unused getOrgId helper to satisfy linting

/** GET /api/flows
 * List all non-deleted flows for the current user's organization (with latest version number if available)
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.user?.org;
    if (!orgId) {
      return res.status(401).json({ error: 'Organization not found' });
    }

    // Optional query param to only return flows created by the current user
    const mineOnly = String(req.query.mine || '').toLowerCase() === 'true';
    let sql = `
      SELECT f.id, f.name, f.description, f.status, f.created_at, f.updated_at, f.created_by,
             COALESCE(MAX(v.version), 0) AS latest_version
      FROM flows f
      LEFT JOIN flow_versions v ON v.flow_id = f.id
      WHERE f.is_deleted = FALSE AND f.org_id = $1
    `;
    const params = [orgId];

    if (mineOnly) {
      sql += ` AND f.created_by = $2 `;
      params.push(req.user?.id);
    }

    sql += ` GROUP BY f.id ORDER BY f.created_at DESC `;

    const rows = await query(sql, params);
    res.json(rows.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list flows' });
  }
});

/** POST /api/flows
 * Body: { name, description }
 * Creates a new flow under the current user's organization
 */
router.post('/', async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const orgId = req.user?.org;
    if (!orgId) {
      return res.status(401).json({ error: 'Organization not found' });
    }

    const createdBy = req.user?.id || null;
    const result = await query(
      `
      INSERT INTO flows (org_id, name, description, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id, org_id, name, description, created_at, updated_at, is_deleted, created_by
      `,
      [orgId, name, description || null, createdBy]
    );

    // ✅ Audit: flow created
    await audit(req, {
      userId: req.user?.id ?? null,
      action: "FLOW_CREATE",
      targetType: "flow",
      targetId: result.rows[0].id,
      statusCode: 201,
      metadata: { name: result.rows[0].name }
    });

    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create flow' });
  }
});

/** GET /api/flows/:id
 * Returns flow info + latest version payload if exists
 * Only returns flows belonging to the current user's organization
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const orgId = req.user?.org;
  
  if (!orgId) {
    return res.status(401).json({ error: 'Organization not found' });
  }

  try {
    const flowRes = await query(
      `SELECT * FROM flows WHERE id = $1 AND org_id = $2 AND is_deleted = FALSE`, 
      [id, orgId]
    );
    if (flowRes.rows.length === 0) return res.status(404).json({ error: 'Flow not found' });

    const verRes = await query(
      `SELECT id, version, graph, variables, created_at, created_by
       FROM flow_versions
       WHERE flow_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [id]
    );

    // Defensive: ensure graph in latestVersion is parsed JSON (some DB drivers may return as string)
    const latest = verRes.rows[0] || null;
    if (latest && latest.graph && typeof latest.graph === 'string') {
      try {
        latest.graph = JSON.parse(latest.graph);
      } catch (e) {
        console.warn('Could not parse latestVersion.graph JSON for flow', id, e.message);
      }
    }

    res.json({
      flow: flowRes.rows[0],
      latestVersion: latest
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch flow' });
  }
});

/** POST /api/flows/:id/versions
 * Body: { graph, variables }
 * Creates a new version: version = (max(version) + 1) or 1 if none.
 * `graph` and `variables` should be JSON.
 */
router.post('/:id/versions', async (req, res) => {
  const { id } = req.params;
  const { graph, variables } = req.body || {};
  if (!graph) return res.status(400).json({ error: 'graph (JSON) is required' });

  try {
    // check flow exists
    const flowRes = await query(`SELECT id, name FROM flows WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (flowRes.rows.length === 0) return res.status(404).json({ error: 'Flow not found' });

    // compute next version
    const maxRes = await query(`SELECT COALESCE(MAX(version), 0) AS maxv FROM flow_versions WHERE flow_id = $1`, [id]);
    const nextVersion = Number(maxRes.rows[0].maxv) + 1;

    const ins = await query(
      `INSERT INTO flow_versions (flow_id, version, graph, variables)
       VALUES ($1, $2, $3::jsonb, COALESCE($4::jsonb, '{}'::jsonb))
       RETURNING id, flow_id, version, graph, variables, created_at, created_by`,
      [id, nextVersion, JSON.stringify(graph), variables ? JSON.stringify(variables) : null]
    );

    // bump updated_at on flow
    await query(`UPDATE flows SET updated_at = now() WHERE id = $1`, [id]);

    //new version created
    await audit(req, {
      userId: req.user?.id ?? null,
      action: "FLOW_VERSION_CREATE",
      targetType: "flow_version",
      targetId: ins.rows[0].id,
      statusCode: 201,
      metadata: { flowId: id, flowName: flowRes.rows[0].name, version: ins.rows[0].version }
    });

    res.status(201).json(ins.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create flow version' });
  }
});

/** GET /api/flows/:id/versions
 * List all versions metadata for a flow
 */
router.get('/:id/versions', async (req, res) => {
  const { id } = req.params;
  try {
    const flowRes = await query(`SELECT id FROM flows WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (flowRes.rows.length === 0) return res.status(404).json({ error: 'Flow not found' });

    const rows = await query(
      `SELECT id, version, created_at, created_by
       FROM flow_versions
       WHERE flow_id = $1
       ORDER BY version DESC`,
      [id]
    );
    res.json(rows.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

/** GET /api/flows/:id/versions/:version
 * Fetch a specific version (graph + variables)
 */
router.get('/:id/versions/:version', async (req, res) => {
  const { id, version } = req.params;
  try {
    const row = await query(
      `SELECT id, flow_id, version, graph, variables, created_at, created_by
       FROM flow_versions
       WHERE flow_id = $1 AND version = $2`,
      [id, Number(version)]
    );
    if (row.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    res.json(row.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch version' });
  }
});

/** PATCH /api/flows/:id/status
 * Update flow status (for deployment)
 * When status changes to 'active', automatically trigger execution
 */
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  
  if (!status || !['inactive', 'active', 'draft'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: inactive, active, or draft' });
  }

  try {
    const upd = await query(
      `UPDATE flows SET status = $1, updated_at = now() WHERE id = $2 AND is_deleted = FALSE RETURNING *`,
      [status, id]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Flow not found' });

    const flow = upd.rows[0];

    // flow status updated
    await audit(req, {
      userId: req.user?.id ?? null,
      action: "FLOW_STATUS_UPDATE",
      targetType: "flow",
      targetId: id,
      statusCode: 200,
      metadata: { status: status, name: flow.name }
    });

    // If deploying (status = active), trigger execution
    let executionResult = null;
    if (status === 'active') {
      try {
        executionResult = await ExecutionService.startExecution(id, 'deploy', {
          deployedBy: req.user?.id ?? 'system',
          deployedAt: new Date().toISOString()
        });
        console.log(`Flow ${flow.name} deployed and execution started:`, executionResult.executionId);
      } catch (execError) {
        console.error('Failed to start execution on deploy:', execError);
        // Don't fail the status update if execution fails
      }
    }

    res.json({
      ...flow,
      execution: executionResult
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update flow status' });
  }
});

/** DELETE /api/flows/:id
 * Soft delete a flow
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const upd = await query(`UPDATE flows SET is_deleted = TRUE, updated_at = now() WHERE id = $1`, [id]);
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Flow not found' });

    // flow deleted
    await audit(req, {
      userId: req.user?.id ?? null,
      action: "FLOW_DELETE",
      targetType: "flow",
      targetId: id,
      statusCode: 200
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete flow' });
  }
});

export default router;

// --- DEBUG: helper endpoint (authenticated) -------------------------------------------------
// GET /api/flows/debug/my-flows
// Returns full flow rows for the current user (including latest version graph) to aid debugging.
// This is safe: it uses the same org/user auth as other endpoints.
router.get('/debug/my-flows', async (req, res) => {
  try {
    const orgId = req.user?.org;
    const userId = req.user?.id;
    if (!orgId || !userId) return res.status(401).json({ error: 'Organization or user not found' });

    const rows = await query(
      `SELECT f.id, f.name, f.description, f.status, f.created_at, f.updated_at, f.created_by,
              COALESCE(MAX(v.version), 0) AS latest_version
       FROM flows f
       LEFT JOIN flow_versions v ON v.flow_id = f.id
       WHERE f.is_deleted = FALSE AND f.org_id = $1 AND f.created_by = $2
       GROUP BY f.id ORDER BY f.created_at DESC`,
      [orgId, userId]
    );

    // Attach latestVersion payload (graph) if exists
    const out = [];
    for (const f of rows.rows) {
      const ver = await query(
        `SELECT id, version, graph, variables, created_at, created_by
         FROM flow_versions WHERE flow_id = $1 ORDER BY version DESC LIMIT 1`,
        [f.id]
      );
      const latest = ver.rows[0] || null;
      if (latest && latest.graph && typeof latest.graph === 'string') {
        try { latest.graph = JSON.parse(latest.graph); } catch (e) { /* ignore */ }
      }
      out.push({ flow: f, latestVersion: latest });
    }

    res.json(out);
  } catch (e) {
    console.error('Debug my-flows failed', e);
    res.status(500).json({ error: 'Debug query failed' });
  }
});

// src/routes/flows.js
import express from "express";
import { query } from "../db/postgres.js";
import { audit } from "../logging/audit.js";

const router = express.Router();

/** Helper: get org_id for 'Demo Org' (or any org you choose) */
async function getOrgId() {
  const res = await query(`SELECT id FROM organizations WHERE name = 'Demo Org' LIMIT 1`);
  if (res.rows.length === 0) throw new Error('Demo Org not found. Seed organizations first.');
  return res.rows[0].id;
}

/** GET /api/flows
 * List all non-deleted flows (with latest version number if available)
 */
router.get('/', async (_req, res) => {
  try {
    const rows = await query(
      `
      SELECT f.id, f.name, f.description, f.created_at, f.updated_at,
             COALESCE(MAX(v.version), 0) AS latest_version
      FROM flows f
      LEFT JOIN flow_versions v ON v.flow_id = f.id
      WHERE f.is_deleted = FALSE
      GROUP BY f.id
      ORDER BY f.created_at DESC
      `
    );
    res.json(rows.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list flows' });
  }
});

/** POST /api/flows
 * Body: { name, description }
 * Creates a new flow under Demo Org
 */
router.post('/', async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const orgId = await getOrgId();
    const result = await query(
      `
      INSERT INTO flows (org_id, name, description)
      VALUES ($1, $2, $3)
      RETURNING id, org_id, name, description, created_at, updated_at, is_deleted
      `,
      [orgId, name, description || null]
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
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const flowRes = await query(`SELECT * FROM flows WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (flowRes.rows.length === 0) return res.status(404).json({ error: 'Flow not found' });

    const verRes = await query(
      `SELECT id, version, graph, variables, created_at, created_by
       FROM flow_versions
       WHERE flow_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [id]
    );

    res.json({
      flow: flowRes.rows[0],
      latestVersion: verRes.rows[0] || null
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

    // flow status updated
    await audit(req, {
      userId: req.user?.id ?? null,
      action: "FLOW_STATUS_UPDATE",
      targetType: "flow",
      targetId: id,
      statusCode: 200,
      metadata: { status: status, name: upd.rows[0].name }
    });

    res.json(upd.rows[0]);
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

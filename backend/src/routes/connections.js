import express from "express";
import { body, validationResult } from "express-validator";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db/postgres.js";
import { encryptJSON, decryptJSON } from "../utils/crypto.js";
import { getAccessToken } from "../providers/mtn/auth.js";

// Removed unused devUser constant (was for early testing) to satisfy lint

const router = express.Router();

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS connections (
      id UUID PRIMARY KEY,
      owner_user_id UUID NOT NULL,
      provider TEXT NOT NULL,
      env TEXT NOT NULL,
      label TEXT NOT NULL,
      config_enc TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections(owner_user_id);
  `);
}
ensureTable().catch(console.error);

// Test only (no save)
router.post("/test",
  body("provider").equals("mtn"),
  body("env").isIn(["sandbox","production"]),
  body("label").isLength({min:1}),
  body("config.subscriptionKey").isLength({min:10}),
  body("config.apiUserId").isUUID(),
  body("config.apiKey").isLength({min:8}),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const cfg = req.body.config;
      const baseUrl = cfg.baseUrl || "https://sandbox.momodeveloper.mtn.com";
      const tok = await getAccessToken({
        subscriptionKey: cfg.subscriptionKey, apiUserId: cfg.apiUserId, apiKey: cfg.apiKey, baseUrl
      });
      res.json({ ok: true, tokenPreview: tok.access_token?.slice(0,10)+"…", expiresIn: tok.expires_in });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.response?.data || e.message });
    }
  }
);

// Save connection
router.post("/",
  body("provider").equals("mtn"),
  body("env").isIn(["sandbox","production"]),
  body("label").isLength({min:1}),
  body("config.subscriptionKey").isLength({min:10}),
  body("config.apiUserId").isUUID(),
  body("config.apiKey").isLength({min:8}),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const id = uuidv4();
    const owner = req.user?.id || uuidv4(); // TODO: replace with actual user id from your auth
    const orgId = req.user?.org;
    const cfg = {
      subscriptionKey: req.body.config.subscriptionKey,
      apiUserId: req.body.config.apiUserId,
      apiKey: req.body.config.apiKey,
      baseUrl: req.body.config.baseUrl || "https://sandbox.momodeveloper.mtn.com",
      targetEnvironment: req.body.config.targetEnvironment || req.body.env || "sandbox",
      callbackUrl: req.body.config.callbackUrl || null,
    };
    
    // Test the connection before saving
    try {
      const baseUrl = cfg.baseUrl || "https://sandbox.momodeveloper.mtn.com";
      await getAccessToken({
        subscriptionKey: cfg.subscriptionKey, 
        apiUserId: cfg.apiUserId, 
        apiKey: cfg.apiKey, 
        baseUrl
      });
      
      // Create or update MTN integration in the database
      if (orgId) {
        const integrationName = req.body.label || 'MTN Mobile Money';
        console.log('[MTN SAVE] Creating integration with name:', integrationName, 'for org:', orgId);
        
        try {
          // Check if integration already exists
          const { rows: existing } = await query(
            `SELECT id FROM integrations WHERE org_id = $1 AND LOWER(name) = LOWER($2)`,
            [orgId, integrationName]
          );
          
          console.log('[MTN SAVE] Existing integrations found:', existing.length);
          
          if (existing.length > 0) {
            // Update existing integration
            console.log('[MTN SAVE] Updating existing integration');
            await query(
              `UPDATE integrations SET status = 'active', last_checked = now() WHERE org_id = $1 AND LOWER(name) = LOWER($2)`,
              [orgId, integrationName]
            );
            console.log('[MTN SAVE] Successfully updated integration');
          } else {
            // Create new integration
            console.log('[MTN SAVE] Creating new integration');
            const { rows: inserted } = await query(
              `INSERT INTO integrations (org_id, name, status, created_at, last_checked) VALUES ($1, $2, 'active', now(), now()) RETURNING id, name, status`,
              [orgId, integrationName]
            );
            console.log('[MTN SAVE] Successfully created integration:', inserted[0]);
          }
        } catch (dbErr) {
          console.error('[MTN SAVE] Database error:', dbErr);
          // Don't throw - we still want to save the connection credentials
        }
      } else {
        console.log('[MTN SAVE] No orgId found, skipping database integration creation');
      }
    } catch (e) {
      // Mark as error if verification fails
      if (orgId) {
        const integrationName = req.body.label || 'MTN Mobile Money';
        console.log('[MTN SAVE] Connection test failed, marking integration as error');
        await query(
          `UPDATE integrations SET status = 'error', last_checked = now() WHERE org_id = $1 AND LOWER(name) = LOWER($2)`,
          [orgId, integrationName]
        ).catch(err => console.error('Failed to update MTN integration error status:', err));
      }
      return res.status(400).json({ ok: false, error: e.response?.data || e.message });
    }
    
    await ensureTable();
    await query(
      "INSERT INTO connections(id, owner_user_id, provider, env, label, config_enc) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, owner, req.body.provider, req.body.env, req.body.label, encryptJSON(cfg)]
    );
    res.json({ id, provider: req.body.provider, env: req.body.env, label: req.body.label });
  }
);

// List connections
router.get("/", async (req, res) => {
  await ensureTable();
  const provider = req.query.provider || null;
  const owner = req.user?.id || null;
  const rows = await query(
    `SELECT id, provider, env, label, created_at FROM connections
     WHERE ($1::uuid IS NULL OR owner_user_id=$1)
       AND ($2::text IS NULL OR provider=$2)
     ORDER BY created_at DESC`,
    [owner, provider]
  );
  res.json(rows.rows);
});

// (Optional) read one (redacted)
router.get("/:id", async (req, res) => {
  await ensureTable();
  const { rows } = await query(
    "SELECT id, provider, env, label, config_enc FROM connections WHERE id=$1",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const cfg = decryptJSON(rows[0].config_enc);
  const redacted = { ...cfg, subscriptionKey: "****", apiKey: "****" };
  res.json({ id: rows[0].id, provider: rows[0].provider, env: rows[0].env, label: rows[0].label, config: redacted });
});

export default router;



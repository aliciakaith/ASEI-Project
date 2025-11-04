import express from 'express';
import flutterwaveClient from '../providers/flutterwave/index.js';
import { listConnectors, saveConnector, getConnectorSecret } from '../db/connectorStore.js';
import { query } from '../db/postgres.js';

const router = express.Router();
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3';
const WEBHOOK_SECRET = process.env.FLW_WEBHOOK_SECRET || '';

function getUserId(req) {
  // If your auth middleware sets req.user, use that. Fall back to dev id.
  return req.user?.id || 'dev-user';
}

/** List all connectors (any provider) for the logged-in user */
router.get('/api/connectors', (req, res) => {
  return res.json({ items: listConnectors(getUserId(req)) });
});

/** Save Flutterwave connector after verifying keys */
router.post('/api/connectors/flutterwave', express.json(), async (req, res) => {
  const userId = getUserId(req);
  const { publicKey, secretKey, encryptionKey, accountAlias } = req.body || {};
  if (!publicKey || !secretKey || !encryptionKey) {
    return res.status(400).json({ error: 'publicKey, secretKey, encryptionKey are required' });
  }
  try {
    const fw = flutterwaveClient({ secretKey, baseUrl: FLW_BASE_URL });
    await fw.ping();
  } catch (e) {
    return res.status(400).json({ error: `Key verification failed: ${e.message}` });
  }
  const saved = saveConnector(
    userId,
    'flutterwave',
    { accountAlias: accountAlias || 'Flutterwave' },
    { publicKey, secretKey, encryptionKey }
  );
  return res.json(saved);
});

/** Test an existing connector */
router.post('/api/connectors/flutterwave/test', express.json(), async (req, res) => {
  const userId = getUserId(req);
  const { connectorId } = req.body || {};
  const creds = getConnectorSecret(userId, connectorId);
  if (!creds) return res.status(404).json({ ok: false, error: 'Connector not found' });
  try {
    const fw = flutterwaveClient({ secretKey: creds.secretKey, baseUrl: FLW_BASE_URL });
    await fw.ping();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/** Create a hosted checkout payment */
router.post('/api/flutterwave/payments', express.json(), async (req, res) => {
  const userId = getUserId(req);
  const orgId = req.user?.org;
  const {
    connectorId,
    amount,
    currency = 'NGN',
    tx_ref,
    customer = { email: 'buyer@example.com' },
    meta,
    redirect_url = 'http://localhost:3001/flow_designer.html#return',
  } = req.body || {};

  if (!connectorId || !amount || !customer?.email) {
    return res.status(400).json({ error: 'connectorId, amount, customer.email are required' });
  }

  const creds = getConnectorSecret(userId, connectorId);
  if (!creds) return res.status(404).json({ error: 'Connector not found' });

  const startTime = Date.now();
  try {
    const fw = flutterwaveClient({ secretKey: creds.secretKey, baseUrl: FLW_BASE_URL });
    const resp = await fw.createPayment({
      amount,
      currency,
      tx_ref: tx_ref || `tx-${Date.now()}`,
      customer,
      meta,
      redirect_url,
    });
    
    // Log successful transaction
    const latency = Date.now() - startTime;
    if (orgId) {
      await query(
        `INSERT INTO tx_events (org_id, success, latency_ms) VALUES ($1, $2, $3)`,
        [orgId, true, latency]
      ).catch(err => console.error('Failed to log Flutterwave tx_event:', err));
    }
    
    return res.json({ ok: true, data: resp });
  } catch (e) {
    // Log failed transaction
    const latency = Date.now() - startTime;
    if (orgId) {
      await query(
        `INSERT INTO tx_events (org_id, success, latency_ms) VALUES ($1, $2, $3)`,
        [orgId, false, latency]
      ).catch(err => console.error('Failed to log Flutterwave tx_event:', err));
    }
    
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/** Verify a payment by reference */
router.get('/api/flutterwave/verify', async (req, res) => {
  const userId = getUserId(req);
  const orgId = req.user?.org;
  const { connectorId, tx_ref } = req.query || {};
  if (!connectorId || !tx_ref) return res.status(400).json({ error: 'connectorId & tx_ref are required' });

  const creds = getConnectorSecret(userId, connectorId);
  if (!creds) return res.status(404).json({ error: 'Connector not found' });

  const startTime = Date.now();
  try {
    const fw = flutterwaveClient({ secretKey: creds.secretKey, baseUrl: FLW_BASE_URL });
    const data = await fw.verifyByReference(tx_ref);
    
    // Log successful verification
    const latency = Date.now() - startTime;
    if (orgId) {
      await query(
        `INSERT INTO tx_events (org_id, success, latency_ms) VALUES ($1, $2, $3)`,
        [orgId, true, latency]
      ).catch(err => console.error('Failed to log Flutterwave verify tx_event:', err));
    }
    
    return res.json({ ok: true, data });
  } catch (e) {
    // Log failed verification
    const latency = Date.now() - startTime;
    if (orgId) {
      await query(
        `INSERT INTO tx_events (org_id, success, latency_ms) VALUES ($1, $2, $3)`,
        [orgId, false, latency]
      ).catch(err => console.error('Failed to log Flutterwave verify tx_event:', err));
    }
    
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/** Webhook endpoint (optional, for async confirmations) */
router.post('/webhooks/flutterwave', express.json({ type: '*/*' }), (req, res) => {
  const sig = req.headers['verif-hash'];
  if (WEBHOOK_SECRET && sig !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  // TODO: hook into your flow runner here
  console.log('FW Webhook:', JSON.stringify(req.body));
  return res.sendStatus(200);
});

export default router;

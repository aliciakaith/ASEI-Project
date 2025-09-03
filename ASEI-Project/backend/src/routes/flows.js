import { Router } from 'express';
import { saveFlow, getFlow, listFlows } from '../db/fileStore.js';

const router = Router();

/**
 * POST /api/flows
 * body: { id: string, name: string, nodes: [], edges: [], meta?: {} }
 */
router.post('/', async (req, res) => {
  const { id, name, nodes = [], edges = [], meta = {} } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  try {
    await saveFlow({ id, name, nodes, edges, meta });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save flow' });
  }
});

/** GET /api/flows/:id */
router.get('/:id', async (req, res) => {
  const flow = await getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });
  res.json(flow);
});

/** GET /api/flows */
router.get('/', async (_req, res) => {
  const items = await listFlows();
  res.json(items);
});

export default router;

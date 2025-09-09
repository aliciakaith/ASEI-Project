import express from 'express';
import { query } from '../db/postgres.js';

const router = express.Router();

// GET all roles
router.get('/', async (_req, res) => {
  try {
    const result = await query('SELECT id, name FROM roles ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching roles:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;

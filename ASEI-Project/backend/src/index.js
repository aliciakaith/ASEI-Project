// src/index.js
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import flowsRouter from './routes/flows.js';
import rolesRouter from './routes/roles.js';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import { requireAuth } from './middleware/authMiddleware.js';



const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

// --- API routes ---
app.use('/api/auth', authRouter);
app.use('/api/flows', requireAuth, flowsRouter);
app.use('/api/roles', requireAuth, rolesRouter);
app.use('/api', requireAuth, dashboardRouter); // other protected endpoints

// --- Serve static frontend (your HTML/CSS/JS lives here) ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../../../ASEI_frontend');

console.log('Serving static from:', FRONTEND_DIR);

app.use(express.static(FRONTEND_DIR));

// Default landing
app.get('/', (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'login.html'));
});

// Keep a simple API 404 (after all routes)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Optional: a plain 404 for non-API paths (static will have handled valid files)
app.use((_req, res) => res.status(404).send('Page not found'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`App running at http://localhost:${PORT}`));

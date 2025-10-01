// src/index.js
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';

import flowsRouter from './routes/flows.js';
import rolesRouter from './routes/roles.js';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import { requireAuth } from './middleware/authMiddleware.js';

const SECRET = process.env.JWT_SECRET || 'supersecret';
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// --- API routes ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});
app.use('/api/auth', authRouter);
app.use('/api/flows', requireAuth, flowsRouter);
app.use('/api/roles', requireAuth, rolesRouter);
app.use('/api', requireAuth, dashboardRouter);

// --- Static frontend (NO auto index) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Adjust to where your HTML lives inside THIS repo on Render
const FRONTEND_DIR = path.resolve(__dirname, '../../../ASEI_frontend');

// Helpful log to confirm files exist in Render container
try {
  console.log('Serving static from:', FRONTEND_DIR);
  console.log('Frontend files:', fs.readdirSync(FRONTEND_DIR));
} catch (e) {
  console.warn('FRONTEND_DIR not readable:', e.message);
}

// 1) Disable auto-serving index.html
app.use(express.static(FRONTEND_DIR, { index: false }));

// 2) Tiny page guard (redirect, not JSON)
function requireAuthPage(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, SECRET);
    return next();
  } catch {
    res.clearCookie('token', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    return res.redirect('/login');
  }
}

// 3) Friendly routes for pages
app.get('/login', (_req, res) =>
  res.sendFile(path.join(FRONTEND_DIR, 'login.html'))
);
app.get('/dashboard', requireAuthPage, (_req, res) =>
  res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html'))
);

// 4) Landing logic: go to login unless JWT is valid
app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, SECRET);
    return res.redirect('/dashboard');
  } catch {
    return res.redirect('/login');
  }
});

// 5) API 404
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// 6) Last-resort catch-all: never leak to a dashboard by accident
app.get('*', (_req, res) => res.redirect('/login'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`App running on :${PORT}`));

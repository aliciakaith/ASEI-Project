import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import flowsRouter from './routes/flows.js';
import rolesRouter from './routes/roles.js';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js'; // 👈 NEW
import { requireAuth } from './middleware/authMiddleware.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

// Public auth (signup/verify/etc.)
app.use('/api/auth', authRouter);

// Protected APIs
app.use('/api/flows', requireAuth, flowsRouter);
app.use('/api/roles', requireAuth, rolesRouter);

// Dashboard endpoints your UI expects (all protected)
app.use('/api', dashboardRouter); // exposes /api/me, /api/kpis, /api/transactions/series, /api/integrations

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

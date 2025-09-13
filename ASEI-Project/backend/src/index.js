import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import flowsRouter from './routes/flows.js';
import rolesRouter from './routes/roles.js';
import authRouter from './routes/auth.js';
import { requireAuth } from './middleware/authMiddleware.js'; // 👈 add this

const app = express();

// Middleware
app.use(cors({
  origin: true,           // reflect the request’s origin (so 192.168.1.158:3000 works too)
  credentials: true
}));

app.use(express.json());
app.use(cookieParser()); // 👈 needed for JWT in cookies

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRouter);              // 👈 public (signup/login)
app.use('/api/flows', requireAuth, flowsRouter); // 👈 protected
app.use('/api/roles', requireAuth, rolesRouter); // 👈 protected

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

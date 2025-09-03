import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import flowsRouter from './routes/flows.js';

const app = express();
app.use(cors());
app.use(express.json());

// health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

// flows api
app.use('/api/flows', flowsRouter);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

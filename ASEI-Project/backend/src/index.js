import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import flowsRouter from './routes/flows.js';
import { requireApiKey } from './middleware/apiKey.js';   
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

// protect write ops with API key
app.post('/api/flows', requireApiKey);

// flows API routes
app.use('/api/flows', flowsRouter);

// 👉 Serve static frontend (HTML/CSS/JS) from ASEI_frontend
const staticDir = path.join(__dirname, '../../../ASEI_frontend');
app.use(express.static(staticDir));

// Friendly routes → map clean paths to your HTML files
app.get('/', (_req, res) => {
  res.sendFile(path.join(staticDir, 'asei_dashboard.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(staticDir, 'asei_dashboard.html'));
});

app.get('/flow-designer', (_req, res) => {
  res.sendFile(path.join(staticDir, 'flow_designer.html'));
});

app.get('/connectors', (_req, res) => {
  res.sendFile(path.join(staticDir, 'Connectors.html')); // note the capital C
});

app.get('/monitoring', (_req, res) => {
  res.sendFile(path.join(staticDir, 'monitoring.html'));
});

app.get('/settings', (_req, res) => {
  res.sendFile(path.join(staticDir, 'settings.html'));
});

app.get('/deployments', (_req, res) => {
  res.sendFile(path.join(staticDir, 'deployments.html'));
});

app.get('/templates', (_req, res) => {
  res.sendFile(path.join(staticDir, 'templates.html'));
});


// 404 fallback for anything else
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

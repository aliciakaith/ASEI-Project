import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import flowsRouter from './routes/flows.js';
import rolesRouter from './routes/roles.js';   // 👈 add this

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'asei-backend', ts: new Date().toISOString() });
});

app.use('/api/flows', flowsRouter);
app.use('/api/roles', rolesRouter);           // 👈 mount it here

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

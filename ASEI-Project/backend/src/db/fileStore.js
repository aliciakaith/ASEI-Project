import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');

async function ensureStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(FLOWS_FILE);
  } catch {
    await fs.writeFile(FLOWS_FILE, JSON.stringify({ flows: {} }, null, 2));
  }
}

export async function saveFlow(flow) {
  await ensureStore();
  const raw = await fs.readFile(FLOWS_FILE, 'utf-8');
  const json = JSON.parse(raw);
  json.flows[flow.id] = { ...flow, updatedAt: new Date().toISOString() };
  await fs.writeFile(FLOWS_FILE, JSON.stringify(json, null, 2));
}

export async function getFlow(id) {
  await ensureStore();
  const raw = await fs.readFile(FLOWS_FILE, 'utf-8');
  const json = JSON.parse(raw);
  return json.flows[id] || null;
}

export async function listFlows() {
  await ensureStore();
  const raw = await fs.readFile(FLOWS_FILE, 'utf-8');
  const json = JSON.parse(raw);
  return Object.values(json.flows);
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { encryptJSON, decryptJSON } from '../utils/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../..', 'data', 'connectors.json');

function ensureFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

export function listConnectors(userId) {
  ensureFile();
  const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return all.filter(c => c.userId === userId)
            .map(({ id, provider, meta, createdAt }) => ({ id, provider, meta, createdAt }));
}

export function saveConnector(userId, provider, meta, secretObj) {
  ensureFile();
  const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const rec = {
    id: uuid(),
    userId,
    provider,               // 'flutterwave'
    meta,                   // e.g. { accountAlias: '...' }
    secret: encryptJSON(secretObj), // { publicKey, secretKey, encryptionKey }
    createdAt: new Date().toISOString(),
  };
  all.push(rec);
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
  const { id, createdAt } = rec;
  return { id, provider, meta, createdAt };
}

export function getConnectorSecret(userId, connectorId) {
  ensureFile();
  const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const rec = all.find(r => r.id === connectorId && r.userId === userId);
  if (!rec) return null;
  return decryptJSON(rec.secret);
}

import express from "express";
import fs from "fs";
import path from "path";
import { encryptJSON, decryptJSON } from "../utils/crypto.js";

const router = express.Router();
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function getFilePath(userId) {
  return path.join(dataDir, `connectors_${userId}.json`);
}

function loadUserConnectors(userId) {
  const p = getFilePath(userId);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveUserConnectors(userId, connectors) {
  const p = getFilePath(userId);
  fs.writeFileSync(p, JSON.stringify(connectors, null, 2));
}

// GET /api/connectors?userId=123
router.get("/", (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });
  const data = loadUserConnectors(userId);
  res.json({ ok: true, connectors: data.map(c => ({ ...c, data: decryptJSON(c.data_encrypted) })) });
});

// POST /api/connectors
router.post("/", (req, res) => {
  const { userId, provider, label, data } = req.body;
  if (!userId || !provider || !data) return res.status(400).json({ ok: false, error: "Missing fields" });
  const connectors = loadUserConnectors(userId);
  const newConn = {
    id: "conn_" + Math.random().toString(36).substring(2),
    provider,
    label,
    data_encrypted: encryptJSON(data),
    created_at: new Date().toISOString()
  };
  connectors.push(newConn);
  saveUserConnectors(userId, connectors);
  res.json({ ok: true, connector: newConn });
});

// DELETE /api/connectors/:id?userId=123
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;
  if (!id || !userId) return res.status(400).json({ ok: false });
  let connectors = loadUserConnectors(userId);
  connectors = connectors.filter(c => c.id !== id);
  saveUserConnectors(userId, connectors);
  res.json({ ok: true });
});

export default router;
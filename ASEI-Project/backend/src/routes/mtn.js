// src/routes/mtn.js
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db/postgres.js";
import { decryptJSON } from "../utils/crypto.js";
import { MTNConnector } from "../providers/mtn/index.js";

const router = express.Router();

async function getConnectionConfig(connectionId) {
  const { rows } = await query("SELECT config_enc FROM connections WHERE id=$1", [connectionId]);
  if (!rows[0]) throw new Error("Connection not found");
  return decryptJSON(rows[0].config_enc);
}

// 🔹 Request to Pay
router.post("/request-to-pay", async (req, res) => {
  try {
    const { connectionId, amount, currency, msisdn, externalId, message } = req.body;
    if (!connectionId || !amount || !msisdn || !externalId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const cfg = await getConnectionConfig(connectionId);
    const connector = new MTNConnector(cfg);
    const referenceId = uuidv4();
    const result = await connector.requestToPay({
      amount,
      currency: currency || "UGX",
      msisdn,
      externalId,
      referenceId,
      message: message || "Payment Request",
      callbackUrl: cfg.callbackUrl
    });
    res.json({ referenceId, result, message: "RequestToPay initiated" });
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// 🔹 Check payment status
router.get("/request-to-pay/:referenceId/status", async (req, res) => {
  try {
    const { connectionId } = req.query;
    const cfg = await getConnectionConfig(connectionId);
    const connector = new MTNConnector(cfg);
    const data = await connector.getStatus(req.params.referenceId);
    res.json({ referenceId: req.params.referenceId, status: data.status });
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// 🔹 Get account balance
router.get("/balance", async (req, res) => {
  try {
    const { connectionId } = req.query;
    const cfg = await getConnectionConfig(connectionId);
    const connector = new MTNConnector(cfg);
    const balance = await connector.getBalance();
    res.json(balance);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// 🔹 Get account holder info
router.get("/accountholder", async (req, res) => {
  try {
    const { connectionId, msisdn } = req.query;
    if (!connectionId || !msisdn) {
      return res.status(400).json({ error: "connectionId and msisdn required" });
    }
    const cfg = await getConnectionConfig(connectionId);
    const connector = new MTNConnector(cfg);
    const holder = await connector.getAccountHolder(msisdn);
    res.json(holder);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

export default router;


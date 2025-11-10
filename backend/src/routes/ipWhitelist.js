// src/routes/ipWhitelist.js
import express from "express";
import { query } from "../db/postgres.js";
import { audit } from "../logging/audit.js";

const router = express.Router();

/**
 * GET /api/ip-whitelist
 * Get current user's IP whitelist
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const result = await query(
      `SELECT id, ip_address, description, created_at 
       FROM ip_whitelist 
       WHERE user_id=$1 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      ok: true,
      whitelist: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch IP whitelist:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ip-whitelist/current-ip
 * Get the current IP address of the requester
 */
router.get("/current-ip", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    // Get client IP address - check multiple sources for robustness
    // Priority: x-forwarded-for (proxy) > x-real-ip (nginx) > req.ip (express trust proxy) > direct connection
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = (
      forwardedFor?.split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      req.ip ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      '0.0.0.0'
    );

    // Normalize IPv6 localhost to IPv4 and remove IPv6 prefix
    let normalizedIp = clientIp;
    if (clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
      normalizedIp = '127.0.0.1';
    } else if (clientIp.startsWith('::ffff:')) {
      normalizedIp = clientIp.replace(/^::ffff:/, '');
    }

    res.json({
      ok: true,
      currentIp: normalizedIp,
      debug: process.env.NODE_ENV !== 'production' ? {
        raw: clientIp,
        sources: {
          'x-forwarded-for': forwardedFor || null,
          'x-real-ip': req.headers['x-real-ip'] || null,
          'req.ip': req.ip || null
        }
      } : undefined
    });
  } catch (error) {
    console.error("Failed to get current IP:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ip-whitelist
 * Add an IP address to whitelist
 */
router.post("/", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { ipAddress, description } = req.body;

    if (!ipAddress) {
      return res.status(400).json({ error: "IP address is required" });
    }

    // Validate IP address format (basic validation)
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ipAddress)) {
      return res.status(400).json({ error: "Invalid IP address format" });
    }

    // Check if IP already exists
    const existing = await query(
      "SELECT id FROM ip_whitelist WHERE user_id=$1 AND ip_address=$2",
      [userId, ipAddress]
    );

    if (existing.rowCount > 0) {
      return res.status(400).json({ error: "IP address already in whitelist" });
    }

    // Add to whitelist
    const result = await query(
      `INSERT INTO ip_whitelist (user_id, ip_address, description) 
       VALUES ($1, $2, $3) 
       RETURNING id, ip_address, description, created_at`,
      [userId, ipAddress, description || null]
    );

    await audit(req, {
      userId,
      action: "IP_WHITELIST_ADD",
      targetType: "ip_whitelist",
      targetId: result.rows[0].id,
      metadata: { ipAddress },
      statusCode: 200
    });

    res.json({
      ok: true,
      message: "IP address added to whitelist",
      entry: result.rows[0]
    });
  } catch (error) {
    console.error("Failed to add IP to whitelist:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/ip-whitelist/:id
 * Remove an IP address from whitelist
 */
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { id } = req.params;

    // Verify ownership and delete
    const result = await query(
      "DELETE FROM ip_whitelist WHERE id=$1 AND user_id=$2 RETURNING ip_address",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "IP whitelist entry not found" });
    }

    await audit(req, {
      userId,
      action: "IP_WHITELIST_REMOVE",
      targetType: "ip_whitelist",
      targetId: id,
      metadata: { ipAddress: result.rows[0].ip_address },
      statusCode: 200
    });

    res.json({
      ok: true,
      message: "IP address removed from whitelist"
    });
  } catch (error) {
    console.error("Failed to remove IP from whitelist:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

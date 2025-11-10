// src/middleware/ipWhitelistMiddleware.js
import { query } from "../db/postgres.js";

/**
 * Middleware to enforce IP whitelist restrictions
 * Checks if user has IP whitelist enabled and if their current IP is allowed
 */
export async function ipWhitelistMiddleware(req, res, next) {
  try {
    const userId = req.user?.id;
    
    // Skip if no authenticated user
    if (!userId) {
      return next();
    }

    // Check if user has IP whitelist enabled
    const userResult = await query(
      "SELECT allow_ip_whitelist FROM users WHERE id=$1",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return next();
    }

    const user = userResult.rows[0];

    // If IP whitelist is not enabled, allow request
    if (!user.allow_ip_whitelist) {
      return next();
    }

    // Get client IP address - use same robust detection as /current-ip endpoint
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

    // Check if IP is in whitelist
    const whitelistResult = await query(
      "SELECT id FROM ip_whitelist WHERE user_id=$1 AND ip_address=$2",
      [userId, normalizedIp]
    );

    if (whitelistResult.rowCount === 0) {
      console.log(`[IP Whitelist] Blocked request from ${normalizedIp} for user ${userId}`);
      return res.status(403).json({
        error: "Access denied",
        message: "Your IP address is not whitelisted. Please contact administrator or add your IP to the whitelist.",
        currentIp: normalizedIp
      });
    }

    // IP is whitelisted, allow request
    next();
  } catch (error) {
    console.error('IP whitelist middleware error:', error);
    // On error, fail open (allow request) to avoid breaking the app
    next();
  }
}

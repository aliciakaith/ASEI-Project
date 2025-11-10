// src/middleware/rateLimitMiddleware.js
import { query } from "../db/postgres.js";

/**
 * Rate limiting middleware - checks user's API rate limit
 * Tracks requests per hour and enforces user-specific limits
 */
export async function rateLimitMiddleware(req, res, next) {
  try {
    // Skip rate limiting for non-authenticated requests
    if (!req.user || !req.user.id) {
      return next();
    }

    const userId = req.user.id;
    
    // Get user's rate limit setting
    const userResult = await query(
      "SELECT rate_limit FROM users WHERE id=$1",
      [userId]
    );
    
    if (!userResult.rowCount) {
      return next();
    }
    
    const rateLimit = userResult.rows[0].rate_limit || 1000;
    
    // Count requests in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const countResult = await query(
      "SELECT COUNT(*) as count FROM api_rate_tracking WHERE user_id=$1 AND timestamp > $2",
      [userId, oneHourAgo]
    );
    
    const requestCount = parseInt(countResult.rows[0].count);
    
    // Check if limit exceeded
    if (requestCount >= rateLimit) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        limit: rateLimit,
        retryAfter: "1 hour",
        message: `You have exceeded your API rate limit of ${rateLimit} requests per hour. Please try again later or increase your limit in settings.`
      });
    }
    
    // Log this request
    await query(
      "INSERT INTO api_rate_tracking (user_id, endpoint, ip_address) VALUES ($1, $2, $3)",
      [userId, req.originalUrl, req.ip]
    );
    
    // Add rate limit info to response headers
    res.setHeader('X-RateLimit-Limit', rateLimit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, rateLimit - requestCount - 1));
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + 60 * 60 * 1000).toISOString());
    
    next();
  } catch (error) {
    console.error('Rate limit middleware error:', error);
    // Don't block request if rate limiting fails
    next();
  }
}

/**
 * Cleanup old tracking records (run periodically)
 * Removes records older than 24 hours
 */
export async function cleanupOldTracking() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await query(
      "DELETE FROM api_rate_tracking WHERE timestamp < $1",
      [oneDayAgo]
    );
    console.log('[Rate Limit] Cleaned up old tracking records');
  } catch (error) {
    console.error('[Rate Limit] Cleanup error:', error);
  }
}

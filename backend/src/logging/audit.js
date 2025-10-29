// backend/src/logging/audit.js
import { logger } from "./logger.js";
import { pool } from "../db/postgres.js"; // now exported as named, may be null in CI

// No-op fast path if DB is disabled or pool not created
const hasPool = !!pool;

export async function audit(
  req,
  {
    userId = null,
    action,
    targetType = null,
    targetId = null,
    statusCode = 200,
    metadata = {}
  }
) {
  if (!hasPool) {
    // In CI (or when DB disabled), don't attempt to write
    logger.debug?.({ msg: "audit_noop", action, targetType, targetId });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO audit_log
       (user_id, action, target_type, target_id, route, method, ip, user_agent, status_code, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        userId,
        action,
        targetType,
        targetId,
        req?.originalUrl ?? null,
        req?.method ?? null,
        req?.ip ?? null,
        req?.headers?.["user-agent"] ?? null,
        statusCode,
        req?.id ?? null,
        metadata // assumes JSON/JSONB column
      ]
    );
  } catch (e) {
    logger.error({ msg: "audit_log_insert_failed", error: e.message });
  }
}

// backend/src/db/postgres.js
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

// Detect if we’re in CI or explicitly skipping the DB
const skipDB = process.env.DISABLE_DB === '1' || process.env.CI === 'true';

let pool = null;

// If DB is disabled (CI, smoke tests, etc.), don’t even try to connect
if (skipDB) {
  console.log('⏭️  Skipping PostgreSQL connection (CI/disabled mode)');
} else {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('❌ DATABASE_URL is not set (Render → Environment).');
  }

  const needsSSL =
    (connStr && !/localhost|127\.0\.0\.1|::1/.test(connStr)) ||
    process.env.PGSSL === 'true';

  pool = new Pool({
    connectionString: connStr || undefined,
    ssl: needsSSL ? { rejectUnauthorized: false } : false,
    keepAlive: true,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => console.error('❌ PG idle client error:', err));

  // Try one connection at startup (optional)
  (async () => {
    try {
      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL');
      client.release();
    } catch (err) {
      console.error('❌ PostgreSQL connection error', err.message);
    }
  })();
}

// Unified query helper (no-op if pool is null)
export const query = async (text, params) => {
  if (!pool) return { rows: [], rowCount: 0 };
  return pool.query(text, params);
};

// Export both ways for flexibility
export { pool };
export default { pool, query };

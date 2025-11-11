// backend/src/db/postgres.js
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

// Detect if we’re in CI or explicitly skipping the DB
const skipDB = process.env.DISABLE_DB === '1' || process.env.CI === 'true';

let pool = null;

if (skipDB) {
  console.log('⏭️  Skipping PostgreSQL connection (CI/disabled mode)');
} else {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('❌ DATABASE_URL is not set (Render → Environment).');
  }

  // When to use SSL
  const needsSSL =
    (connStr && !/localhost|127\.0\.0\.1|::1/.test(connStr)) ||
    process.env.PGSSL === 'true' ||
    process.env.PGSSLMODE === 'require' ||
    process.env.PGSSL_NO_VERIFY === '1';

  // Decide whether to verify the server cert
  // If PGSSL_NO_VERIFY=1, we keep SSL but skip certificate verification.
  const noVerify = process.env.PGSSL_NO_VERIFY === '1';

  // Default: in production verify certs; in dev allow self-signed
  const IS_PROD = process.env.NODE_ENV === 'production';
  const sslConfig = needsSSL
    ? (noVerify
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: IS_PROD ? true : false })
    : false;

  pool = new Pool({
    connectionString: connStr || undefined,
    ssl: sslConfig,
    keepAlive: true,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => console.error('❌ PG idle client error:', err));

  (async () => {
    try {
      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL (ssl:', !!sslConfig, 'verify:', !(sslConfig && sslConfig.rejectUnauthorized === false), ')');
      client.release();
    } catch (err) {
      console.error('❌ PostgreSQL connection error:', err.message);
    }
  })();
}

// Unified query helper (no-op if pool is null)
export const query = async (text, params) => {
  if (!pool) return { rows: [], rowCount: 0 };
  return pool.query(text, params);
};

export { pool };
export default { pool, query };

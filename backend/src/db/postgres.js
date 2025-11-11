// backend/src/db/postgres.js
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const skipDB = process.env.DISABLE_DB === '1' || process.env.CI === 'true';

let pool = null;

if (skipDB) {
  console.log('⏭️  Skipping PostgreSQL connection (CI/disabled mode)');
} else {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('❌ DATABASE_URL is not set.');
  }

  const forceNoVerify = process.env.PGSSL_NO_VERIFY === '1';
  const sslmode = (process.env.PGSSLMODE || '').toLowerCase();

  // If DATABASE_URL has ?sslmode=..., node-postgres will enable TLS;
  // we still control cert verification here:
  const sslNeeded =
    /sslmode=require|verify|prefer/.test(connStr || '') ||
    ['require', 'verify-ca', 'verify-full', 'prefer'].includes(sslmode);

  const IS_PROD = process.env.NODE_ENV === 'production';

  const sslConfig = sslNeeded
    ? (forceNoVerify
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: IS_PROD }) // verify in prod when not overridden
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
      console.log('✅ Connected to PostgreSQL');
      client.release();
    } catch (err) {
      console.error('❌ PostgreSQL connection error:', err.message);
    }
  })();
}

export const query = async (text, params) => {
  if (!pool) return { rows: [], rowCount: 0 };
  return pool.query(text, params);
};

export { pool };
export default { pool, query };

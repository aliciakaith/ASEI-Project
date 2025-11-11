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

  // TLS is needed for remote DBs or when sslmode says so
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(connStr || '');
  const tlsByUrl = /[?&]sslmode=(require|verify-ca|verify-full|prefer)/i.test(connStr || '');
  const tlsByEnv = ['require','verify-ca','verify-full','prefer'].includes(sslmode);

  const needTLS = !isLocal || tlsByUrl || tlsByEnv || forceNoVerify;

  // On Render, be extra permissive unless you’ve supplied a CA
  const onRender = !!process.env.RENDER;

  const sslConfig = needTLS
    ? { rejectUnauthorized: !(forceNoVerify || onRender) }
    : false;

  // Optional: log once so you can see what it's doing
  console.log('PG TLS -> needTLS:', needTLS, 'rejectUnauthorized:', sslConfig ? sslConfig.rejectUnauthorized : false);

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

// backend/src/db/postgres.js
import pkg from "pg";
const { Pool } = pkg;

const connStr = process.env.DATABASE_URL;

// Fail fast if DATABASE_URL is missing (prevents silent localhost fallback)
if (!connStr) {
  console.error("❌ DATABASE_URL is not set. Add it in Render → Environment.");
}

// Render’s managed Postgres requires SSL. Allow self-signed CA on PaaS.
const needsSSL =
  process.env.PGSSL === "true" ||
  (connStr && !/localhost|127\.0\.0\.1|::1/.test(connStr));

const pool = new Pool({
  connectionString: connStr || undefined,  // if undefined, pg will try PGHOST/… or localhost
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  // Optional tuning:
  keepAlive: true,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("❌ Postgres idle client error:", err);
});

(async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to PostgreSQL");
    client.release();
  } catch (err) {
    console.error("❌ PostgreSQL connection error", err);
  }
})();

export const query = (text, params) => pool.query(text, params);
export default pool;

// backend/src/db/postgres.js
import pkg from "pg";
const { Pool } = pkg;

const connStr = process.env.DATABASE_URL;

if (!connStr) {
  console.error("❌ DATABASE_URL is not set (Render → Environment).");
}

const needsSSL =
  (connStr && !/localhost|127\.0\.0\.1|::1/.test(connStr)) ||
  process.env.PGSSL === "true";

const pool = new Pool({
  connectionString: connStr || undefined,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => console.error("❌ PG idle client error:", err));

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

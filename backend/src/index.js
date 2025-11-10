// src/index.js
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { Server } from "socket.io";
import { pool } from "./db/postgres.js";

import flowsRouter from "./routes/flows.js";
import rolesRouter from "./routes/roles.js";
import authRouter from "./routes/auth.js";
import dashboardRouter from "./routes/dashboard.js";
import { requireAuth } from "./middleware/authMiddleware.js";
import { rateLimitMiddleware, cleanupOldTracking } from "./middleware/rateLimitMiddleware.js";
import { ipWhitelistMiddleware } from "./middleware/ipWhitelistMiddleware.js";
import connectionsRouter from "./routes/connections.js";
import mtnRouter from "./routes/mtn.js";
import flutterwaveRoutes from './routes/flutterwave.js';
import executionsRouter from './routes/executions.js';
import templatesRouter from './routes/templates.js';
import ipWhitelistRouter from './routes/ipWhitelist.js';


// logging
import expressWinston from "express-winston";
import { logger } from "./logging/logger.js";
import { requestContext } from "./middleware/requestContext.js";

// ------------------------------------------------------
// Load environment variables from backend/.env
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ------------------------------------------------------
// Initialize Express app
// ------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ------------------------------------------------------
// CORS (must come BEFORE any routes)
// ------------------------------------------------------
import cors from "cors";

const allowlist = [
  "http://localhost:3001", // same origin (backend)
  "http://localhost:5173", // Vite dev
  "http://127.0.0.1:5500", // Live Server
  "http://localhost:8080"  // generic local test
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow same-origin/curl
      cb(null, allowlist.includes(origin));
    },
    credentials: true,
  })
);
// ------------------------------------------------------

// attach correlation IDs BEFORE any logging
app.use(requestContext);


// attach correlation IDs BEFORE any logging
app.use(requestContext);

// … after you create `app`
app.use('/api', flutterwaveRoutes);  // /api/connectors, /api/flutterwave/*
app.use('/', flutterwaveRoutes);     // /webhooks/flutterwave


// request logs (skip noisy health checks)
app.use(
  expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    dynamicMeta: (req, res) => ({
      requestId: req.id,
      ip: req.ip,
      ua: req.headers["user-agent"],
      route: req.originalUrl,
      method: req.method,
      status: res.statusCode
    }),
    msg: "HTTP {{req.method}} {{req.originalUrl}} {{res.statusCode}}",
    ignoreRoute: (req) => req.originalUrl.startsWith("/health")
  })
);

// ------------------------------------------------------
// Health check route
// ------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "asei-backend", ts: new Date().toISOString() });
});

// ------------------------------------------------------
// Protected API routes (with rate limiting and IP whitelist)
// ------------------------------------------------------
app.use("/api/auth", authRouter);
app.use("/api/ip-whitelist", requireAuth, ipWhitelistRouter);
app.use("/api/flows", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, flowsRouter);
app.use("/api/roles", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, rolesRouter);
app.use("/api/dashboard", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, dashboardRouter);
app.use("/api/connections", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, connectionsRouter);
app.use("/api/mtn", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, mtnRouter);
app.use("/api/executions", requireAuth, ipWhitelistMiddleware, rateLimitMiddleware, executionsRouter);

// Public API for templates
app.use("/api/templates", templatesRouter);




// ------------------------------------------------------
// Serve static frontend (optional in CI)
// ------------------------------------------------------
// Also serve backend-local static assets (e.g. admin scripts) from ./src/public
const BACKEND_STATIC = path.resolve(__dirname, 'public');
if (fs.existsSync(BACKEND_STATIC)) {
  app.use(express.static(BACKEND_STATIC));
  console.log('Serving backend static from:', BACKEND_STATIC);
}

const candidates = [
  process.env.STATIC_ROOT,
  path.resolve(__dirname, "../../../ASEI_frontend"),
  path.resolve(__dirname, "../../ASEI_frontend"),
].filter(Boolean);

let FRONTEND_DIR =
  candidates.find(p => fs.existsSync(p) && fs.existsSync(path.join(p, "login.html"))) ||
  candidates.find(p => fs.existsSync(p)) ||
  null;

console.log("STATIC_ROOT =", process.env.STATIC_ROOT);
console.log("Serving static from:", FRONTEND_DIR || "(disabled)");

// Only enable static if we actually have a directory
if (FRONTEND_DIR) {
  app.use(express.static(FRONTEND_DIR, { index: false }));
  const send = (f) => (_req, res) => res.sendFile(path.join(FRONTEND_DIR, f));

  // Frontend routes
  app.get("/", send("login.html"));
  app.get("/login", send("login.html"));
  app.get("/signup", send("signup.html"));
  app.get("/dashboard", send("asei_dashboard.html"));
  app.get("/flow-designer", send("flow_designer.html"));
  app.get("/connectors", send("Connectors.html"));
  app.get("/templates", send("templates.html"));
  app.get("/deployments", send("deployments.html"));
  app.get("/monitoring", send("monitoring.html"));
  app.get("/settings", send("settings.html"));
  app.get("/terms", send("termsAndConditions.html"));
  app.get("/forgot", send("forgot.html"));
} else {
  // Safe default so CI still returns 200 on /
  app.get("/", (_req, res) => res.status(200).send("Backend OK"));
}

// ------------------------------------------------------
// Migrations: ensure required tables exist
// ------------------------------------------------------
async function runMigrations() {
  if (!pool) return;
  try {
    const read = (p) => {
      try { return fs.readFileSync(p, "utf8"); } catch { return null; }
    };
    const DB_DIR = path.resolve(__dirname, "./db");
    const schemaMain = read(path.join(DB_DIR, "schema.sql"));
    const schemaExec = read(path.join(DB_DIR, "execution_schema.sql"));
    const auditDdl = `
      CREATE TABLE IF NOT EXISTS audit_log (
        id           BIGSERIAL PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id      UUID,
        action       TEXT NOT NULL,
        target_type  TEXT,
        target_id    TEXT,
        route        TEXT,
        method       TEXT,
        ip           TEXT,
        user_agent   TEXT,
        status_code  INTEGER,
        request_id   TEXT,
        metadata     JSONB
      );
    `;
    const client = await pool.connect();
    try {
      if (schemaMain) await client.query(schemaMain);
      if (schemaExec) await client.query(schemaExec);
      await client.query(auditDdl);
      console.log("✅ Database schema ensured");
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Failed to run migrations:", err.message || err);
  }
}

// ------------------------------------------------------
// 404 handling
// ------------------------------------------------------
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((_req, res) => res.status(404).send("Page not found"));

// error logs (must be AFTER routes/handlers)
app.use(
  expressWinston.errorLogger({
    winstonInstance: logger
  })
);

// ------------------------------------------------------
// Start the server + Socket.IO
// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
await runMigrations();

// Start rate limit cleanup job (runs every hour)
setInterval(() => {
  cleanupOldTracking();
}, 60 * 60 * 1000);

const server = createServer(app);

const io = new Server(server, {
  cors: { origin: true, credentials: true },
});
app.set("io", io);

io.on("connection", (socket) => {
  socket.on("join-org", (orgId) => {
    if (orgId) socket.join(`org:${orgId}`);
  });
});

// Postgres LISTEN -> forward to Socket.IO for real-time notifications
(async function setupDbListener() {
  if (!pool) return;
  try {
    const client = await pool.connect();
    // Listen on the channel created by the trigger
    await client.query('LISTEN notifications_channel');
    client.on('notification', (msg) => {
      try {
        const payload = msg.payload ? JSON.parse(msg.payload) : {};
        const orgId = payload.org_id || payload.org || null;
        if (orgId) {
          // emit to the org room so frontend clients receive updates
          io.to(`org:${orgId}`).emit('notifications:update');
        }
      } catch (err) {
        console.warn('Failed to handle pg notification', err);
      }
    });
    client.on('error', (err) => console.error('PG listener error', err));
    console.log('Listening to notifications_channel for real-time updates');
  } catch (err) {
    console.error('Failed to set up DB listener for notifications:', err.message || err);
  }
})();

// Auto-verify integrations on startup if env vars are configured
(async function autoVerifyIntegrations() {
  try {
    // Check Flutterwave
    if (process.env.FLW_SECRET_KEY && process.env.FLW_BASE_URL) {
      console.log('Flutterwave credentials detected, verifying...');
      const flutterwaveClient = (await import('./providers/flutterwave/index.js')).default;
      const fw = flutterwaveClient({ 
        secretKey: process.env.FLW_SECRET_KEY, 
        baseUrl: process.env.FLW_BASE_URL 
      });
      try {
        await fw.ping();
        await pool.query(
          `UPDATE integrations SET status = 'active', last_checked = now() WHERE LOWER(name) = 'flutterwave'`
        );
        console.log('✅ Flutterwave integrations marked as active');
      } catch (err) {
        await pool.query(
          `UPDATE integrations SET status = 'error', last_checked = now() WHERE LOWER(name) = 'flutterwave'`
        );
        console.warn('❌ Flutterwave verification failed:', err.message);
      }
    } else {
      // No credentials configured - mark as error (not configured)
      await pool.query(
        `UPDATE integrations SET status = 'error', last_checked = now() WHERE LOWER(name) = 'flutterwave'`
      );
      console.log('⚠️  Flutterwave not configured (missing FLW_SECRET_KEY or FLW_BASE_URL)');
    }

    // Check MTN MoMo
    if (process.env.MTN_SUBSCRIPTION_KEY && process.env.MTN_API_USER && process.env.MTN_API_KEY) {
      console.log('MTN MoMo credentials detected, verifying...');
      const { getAccessToken } = await import('./providers/mtn/auth.js');
      try {
        await getAccessToken({
          subscriptionKey: process.env.MTN_SUBSCRIPTION_KEY,
          apiUserId: process.env.MTN_API_USER,
          apiKey: process.env.MTN_API_KEY,
          baseUrl: process.env.MTN_BASE || 'https://sandbox.momodeveloper.mtn.com'
        });
        await pool.query(
          `UPDATE integrations SET status = 'active', last_checked = now() WHERE LOWER(name) = 'mtn mobile money'`
        );
        console.log('✅ MTN Mobile Money integrations marked as active');
      } catch (err) {
        await pool.query(
          `UPDATE integrations SET status = 'error', last_checked = now() WHERE LOWER(name) = 'mtn mobile money'`
        );
        console.warn('❌ MTN MoMo verification failed:', err.message);
      }
    } else {
      // No credentials configured - mark as error (not configured)
      await pool.query(
        `UPDATE integrations SET status = 'error', last_checked = now() WHERE LOWER(name) = 'mtn mobile money'`
      );
      console.log('⚠️  MTN MoMo not configured (missing credentials in .env)');
    }
  } catch (err) {
    console.error('Failed to auto-verify integrations:', err.message);
  }
})();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`App running at http://localhost:${PORT}`);
});

import connectorsRouter from "./routes/connectors.js";
app.use("/api/connectors", connectorsRouter);
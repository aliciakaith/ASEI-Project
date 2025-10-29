// src/index.js
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { Server } from "socket.io";

import flowsRouter from "./routes/flows.js";
import rolesRouter from "./routes/roles.js";
import authRouter from "./routes/auth.js";
import dashboardRouter from "./routes/dashboard.js";
import { requireAuth } from "./middleware/authMiddleware.js";
import connectionsRouter from "./routes/connections.js";
import mtnRouter from "./routes/mtn.js";

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

// attach correlation IDs BEFORE any logging
app.use(requestContext);

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
// Protected API routes
// ------------------------------------------------------
app.use("/api/auth", authRouter);
app.use("/api/flows", requireAuth, flowsRouter);
app.use("/api/roles", requireAuth, rolesRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/connections", requireAuth, connectionsRouter);
app.use("/api/mtn", requireAuth, mtnRouter);




// ------------------------------------------------------
// Serve static frontend (optional in CI)
// ------------------------------------------------------
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`App running at http://localhost:${PORT}`);
});

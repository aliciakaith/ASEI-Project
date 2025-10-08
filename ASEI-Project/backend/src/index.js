// src/index.js
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";

import flowsRouter from "./routes/flows.js";
import rolesRouter from "./routes/roles.js";
import authRouter from "./routes/auth.js";
import dashboardRouter from "./routes/dashboard.js";
import { requireAuth } from "./middleware/authMiddleware.js";

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
app.use(express.urlencoded({ extended: true })); // for render2
app.use(express.json());
app.use(cookieParser());

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
app.use("/api", requireAuth, dashboardRouter);

// ------------------------------------------------------
// Serve static frontend
// ------------------------------------------------------
const candidates = [
  process.env.STATIC_ROOT,                                 // preferred path from .env
  path.resolve(__dirname, "../../../ASEI_frontend"),       // /Assignment/ASEI_frontend
  path.resolve(__dirname, "../../ASEI_frontend"),          // /Assignment/ASEI-Project/ASEI_frontend
].filter(Boolean);

// pick the first folder that exists and has login.html
let FRONTEND_DIR =
  candidates.find(
    (p) => fs.existsSync(p) && fs.existsSync(path.join(p, "login.html"))
  ) ||
  candidates.find((p) => fs.existsSync(p)) ||
  candidates[0];

console.log("STATIC_ROOT =", process.env.STATIC_ROOT);
console.log("Serving static from:", FRONTEND_DIR);

app.use(express.static(FRONTEND_DIR, { index: false }));

// helper to send pages
const send = (f) => (_req, res) =>
  res.sendFile(path.join(FRONTEND_DIR, f));

// ------------------------------------------------------
// Frontend routes
// ------------------------------------------------------
app.get("/", send("login.html"));
app.get("/login", send("login.html"));
app.get("/signup", send("signup.html"));
app.get("/dashboard", send("asei_dashboard.html"));
app.get("/flow-designer", send("flow_designer.html"));
app.get("/connectors", send("Connectors.html")); // note: capital C
app.get("/templates", send("templates.html"));
app.get("/deployments", send("deployments.html"));
app.get("/monitoring", send("monitoring.html"));
app.get("/settings", send("settings.html"));
app.get("/terms", send("termsAndConditions.html"));

// ------------------------------------------------------
// 404 handling
// ------------------------------------------------------
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Not found" })
);
app.use((_req, res) => res.status(404).send("Page not found"));

// ------------------------------------------------------
// Start the server
// ------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`App running at http://localhost:${PORT}`)
);

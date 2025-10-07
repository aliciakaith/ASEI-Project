// ASEI_frontend/server.js
const express = require("express");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // no CSP yet, disabled
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false, // prevents COEP issues with some CDNs
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "no-referrer" }
}));

// serve static assets (css/js/images) from this folder
app.use(express.static(__dirname));

// helper to send a page
const page = f => (_req, res) => res.sendFile(path.join(__dirname, f));

// home + friendly routes
app.get("/", page("login.html"));
app.get("/dashboard", page("asei_dashboard.html"));
app.get("/flow-designer", page("flow_designer.html"));
app.get("/connectors", page("Connectors.html")); // note the capital C in the filename
app.get("/templates", page("templates.html"));
app.get("/deployments", page("deployments.html"));
app.get("/monitoring", page("monitoring.html"));
app.get("/settings", page("settings.html"));
app.get("/login", page("login.html"));
app.get("/signup", page("signup.html"));
app.get("/terms", page("termsAndConditions.html"));

// Aliases for common variations
app.get("/Connectors", (_req, res) => res.redirect(301, "/connectors"));
app.get("/connectors.html", (_req, res) => res.redirect(301, "/connectors"));

// readable 404
app.use((req, res) => res.status(404).send(`404 Not Found: ${req.url}`));

// Check for secrets in Render env
if (!process.env.JWT_SECRET || !process.env.AES_KEY) {
  console.warn("Missing JWT_SECRET or AES_KEY");
}

// start server
app.listen(PORT, () => {
  console.log(`ASEI server running in ${process.env.NODE_ENV || "development"} mode`);
  console.log(`Listening on port ${PORT}`);
});

// ASEI_frontend/server.js
const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// serve static assets (css/js/images) from this folder
app.use(express.static(__dirname));

// helper to send a page
const page = f => (_req, res) => res.sendFile(path.join(__dirname, f));

// home + friendly routes
app.get("/", page("asei_dashboard.html"));
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

// readable 404
app.use((req, res) => res.status(404).send(`404 Not Found: ${req.url}`));

app.listen(PORT, () => console.log(`UI at http://localhost:${PORT}`));

const express = require("express");
const path = require("path");
const app = express();

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Default route → index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ASEI UI running at http://172.19.121.180:${PORT}`);
});

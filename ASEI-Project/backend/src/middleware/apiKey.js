export function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    console.warn("API_KEY not set; refusing protected request");
    return res.status(500).json({ error: "Server not configured" });
  }

  const provided =
    req.header("x-api-key") ||
    req.query.apiKey || // optional convenience
    "";

  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

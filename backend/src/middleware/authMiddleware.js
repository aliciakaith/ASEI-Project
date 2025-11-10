import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "supersecret";

export function requireAuth(req, res, next) {
  // Accept primary token, or dev fallback token_lax
  const token = req.cookies?.token || req.cookies?.token_lax; // cookie-parser must be used in index.js
  if (!token) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload; // attach decoded { id, email, org } to request
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}



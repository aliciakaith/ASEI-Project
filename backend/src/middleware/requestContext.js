import { randomUUID } from "node:crypto";

export function requestContext(req, _res, next) {
  // Accept inbound request id if present
  req.id = req.headers["x-request-id"] || randomUUID();
  next();
}

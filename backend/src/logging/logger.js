// backend/src/logging/logger.js
import fs from "fs";
import path from "path";
import winston from "winston";
import "winston-daily-rotate-file";

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

const isRender = !!process.env.RENDER;        // Render sets this
const inCI     = process.env.CI === "true";   // GitHub Actions sets this
const level    = process.env.LOG_LEVEL || "info";

// Pretty console for local dev, JSON elsewhere
const consoleFmt = combine(
  colorize(),
  timestamp(),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) =>
    stack
      ? `[${timestamp}] ${level}: ${message}\n${stack}`
      : `[${timestamp}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`
  )
);
const jsonFmt = combine(timestamp(), errors({ stack: true }), json());

const transports = [];

// File logging ONLY when not in CI and not on Render
if (!isRender && !inCI) {
  const logDir = process.env.LOG_DIR || path.resolve("logs");
  try {
    fs.mkdirSync(logDir, { recursive: true }); // create if missing
    transports.push(
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: "app-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: process.env.LOG_RETENTION_DAYS || "14d",
        zippedArchive: true,
        format: jsonFmt,
        level
      })
    );
  } catch (e) {
    // If we can't write logs, fall back to console-only
    // (don't crash the app over logging)
    // eslint-disable-next-line no-console
    console.warn("logger: file logging disabled:", e.message);
  }
}

// Console everywhere
transports.push(
  new winston.transports.Console({
    format: isRender ? jsonFmt : consoleFmt,
    level
  })
);

export const logger = winston.createLogger({
  level,
  format: jsonFmt,
  defaultMeta: { service: "asei-backend" },
  transports
});

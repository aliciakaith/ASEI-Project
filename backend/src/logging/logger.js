import winston from "winston";
import "winston-daily-rotate-file";

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

// pretty console for dev
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

// json file/console for prod
const jsonFmt = combine(timestamp(), errors({ stack: true }), json());

// transports: file in dev, console everywhere; console-only on Render
const transports = [];

const isRender = !!process.env.RENDER; // Render sets this env var
const level = process.env.LOG_LEVEL || "info";

if (!isRender) {
  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: process.env.LOG_DIR || "logs",
      filename: "app-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: process.env.LOG_RETENTION_DAYS || "14d",
      zippedArchive: true
    })
  );
}

transports.push(
  new winston.transports.Console({
    format: isRender ? jsonFmt : consoleFmt
  })
);

export const logger = winston.createLogger({
  level,
  format: jsonFmt,
  defaultMeta: { service: "asei-backend" },
  transports
});

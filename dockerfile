# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runner ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init curl

# deps
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# source
COPY backend ./backend
COPY ASEI_frontend ./ASEI_frontend

# explicit static path (your server also autodetects)
ENV STATIC_ROOT=/app/ASEI_frontend
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/ || exit 1

ENTRYPOINT ["dumb-init","--"]
CMD ["node","backend/src/index.js"]

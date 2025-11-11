# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# copy manifests from repo root (build context will be repo root)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runner ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init curl

# bring production node_modules
COPY --from=deps /app/node_modules ./node_modules

# copy app code (backend + frontend + package files)
COPY backend ./backend
COPY ASEI_frontend ./ASEI_frontend
COPY package*.json ./

# logs dir for non-root user
RUN mkdir -p logs && chown -R node:node /app
USER node

EXPOSE 3001

# If you don't have /health, this checks "/"
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/ || exit 1

ENTRYPOINT ["dumb-init","--"]
# matches actual server entry
CMD ["node","backend/src/index.js"]

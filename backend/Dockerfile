# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# copy backend package files to install dependencies
COPY backend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runner ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init curl

# bring production node_modules
COPY --from=deps /app/node_modules ./node_modules

# copy app code (backend source files)
COPY backend/src ./src
COPY backend/nodemon.json ./
COPY backend/data ./data

# copy frontend
COPY ASEI_frontend ./ASEI_frontend

# logs dir for non-root user
RUN mkdir -p logs data/compliance_reports && chown -R node:node /app
USER node

# Render uses PORT environment variable
EXPOSE ${PORT:-3001}

# If you don't have /health, this checks "/"
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/ || exit 1

ENTRYPOINT ["dumb-init","--"]
CMD ["node","src/index.js"]

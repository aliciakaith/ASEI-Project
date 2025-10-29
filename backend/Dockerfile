# ---- deps stage: install prod deps only, cached by package-lock.json ----
FROM node:20-alpine AS deps
WORKDIR /app
# Copy lockfiles first for better layer cache
COPY package*.json ./
# If you have a lockfile, prefer npm ci; it’s deterministic
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runner stage: minimal image with app code and node_modules ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Optional: install tiny tools for healthchecks/logs
RUN apk add --no-cache dumb-init curl

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
# Copy the rest of your backend (respects .dockerignore)
COPY . .

# Run as non-root for security (node user exists in Node images)
USER node

EXPOSE 3001
# Optional healthcheck (adjust the path if you have a /health route)
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

# Use dumb-init to handle signals properly (graceful shutdowns)
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "src/index.js"]

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# install backend deps (only production)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runner ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init curl

# bring production node_modules
COPY --from=deps /app/node_modules ./node_modules

# copy backend source (context is /backend)
COPY . .

# absolute path to static site in the image (we moved it under backend/)
ENV STATIC_ROOT=/app/ASEI_frontend

# optional: entrypoint to run migrations before starting (see step 2)
# RUN chmod +x /app/entrypoint.sh

# non-root user and writable dirs
RUN mkdir -p logs data data/compliance_reports && chown -R node:node /app
USER node

# Render sets PORT at runtime; default 3001 locally
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/ || exit 1

ENTRYPOINT ["dumb-init","--"]
# If you create entrypoint.sh, switch to: CMD ["/app/entrypoint.sh"]
CMD ["node","src/index.js"]

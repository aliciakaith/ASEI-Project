FROM node:20-alpine
WORKDIR /app

# Copy package files from ASEI_frontend
COPY ASEI_frontend/package*.json ./

# Install dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the frontend code
COPY ASEI_frontend/ ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

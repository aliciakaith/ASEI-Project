FROM node:20-alpine
WORKDIR /app

COPY ASEI_frontend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY ASEI_frontend/ ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

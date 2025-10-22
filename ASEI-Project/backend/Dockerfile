# Use Node 20 (lightweight Alpine version)
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev

# Copy the rest of the backend source code
COPY . .

# Expose the backend port
EXPOSE 3001

# Start the app (same as "npm start")
CMD ["node", "src/index.js"]
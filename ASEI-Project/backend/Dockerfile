# Use Node 20 Alpine for small image size
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency files first
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the rest of the backend source code
COPY . .

# Expose the backend port
EXPOSE 3001

# Start the app (same as npm run dev but without nodemon)
CMD ["node", "src/index.js"]
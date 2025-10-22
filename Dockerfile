# Use Node 20
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy backend files
COPY ASEI-Project/backend/package*.json ./

# Install backend dependencies
RUN npm install --omit=dev

# Copy rest of backend code
COPY ASEI-Project/backend/ ./

# Expose port 3001
EXPOSE 3001

# Start your backend
CMD ["npm", "start"]

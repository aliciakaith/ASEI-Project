# ---- build stage ----
FROM node:18 AS build
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# ---- runtime stage ----
FROM node:18-slim
WORKDIR /app

# Copy built app
COPY --from=build /app .

# Expose app port
EXPOSE 8080
<<<<<<< Updated upstream

# Start the app
CMD ["npm", "start"]

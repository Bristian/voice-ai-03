# Dockerfile for dashboard (Next.js)
#
# Railway configuration:
#   - RAILWAY_DOCKERFILE_PATH=dashboard/Dockerfile
#   - Root Directory: empty (repo root as build context)

FROM node:20-slim

WORKDIR /app

# Copy package files
COPY dashboard/package.json dashboard/package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source
COPY dashboard/ .

# Build Next.js
RUN npm run build

# Default port
ENV PORT=3001
EXPOSE ${PORT}

CMD ["npm", "run", "start"]

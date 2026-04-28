# Dockerfile for dashboard (Next.js standalone)
#
# Railway configuration:
#   - RAILWAY_DOCKERFILE_PATH=dashboard/Dockerfile
#   - Root Directory: empty (repo root as build context)

FROM node:20-slim

WORKDIR /app

# Copy package files and install
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install

# Copy source and build
COPY dashboard/ .
RUN npm run build

# Copy static assets into the standalone output
# (Next.js standalone mode doesn't include these automatically)
RUN cp -r .next/static .next/standalone/.next/static 2>/dev/null || true
RUN cp -r public .next/standalone/public 2>/dev/null || true

ENV PORT=3001
EXPOSE ${PORT}

# Use the standalone server — NOT "next start"
CMD ["node", ".next/standalone/server.js"]

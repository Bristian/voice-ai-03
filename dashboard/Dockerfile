# Dockerfile for dashboard (Next.js standalone)
#
# Railway configuration:
#   - RAILWAY_DOCKERFILE_PATH=dashboard/Dockerfile
#   - Root Directory: empty (repo root as build context)
#
# IMPORTANT: NEXT_PUBLIC_ env vars must be available at BUILD time because
# Next.js inlines them into the JavaScript bundle. Railway automatically
# passes all service env vars as Docker build args.

FROM node:20-slim

WORKDIR /app

# Copy package files and install
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install

# Copy source
COPY dashboard/ .

# Declare build args for NEXT_PUBLIC_ vars.
# Railway passes all env vars as build args automatically.
ARG NEXT_PUBLIC_ECHOKIT_URL
ARG NEXT_PUBLIC_AGENT_API_URL

# Make them available as env vars during the build
ENV NEXT_PUBLIC_ECHOKIT_URL=$NEXT_PUBLIC_ECHOKIT_URL
ENV NEXT_PUBLIC_AGENT_API_URL=$NEXT_PUBLIC_AGENT_API_URL

# Build Next.js (NEXT_PUBLIC_ vars are now baked into the bundle)
RUN npm run build

# Copy static assets into standalone output
RUN cp -r .next/static .next/standalone/.next/static 2>/dev/null || true
RUN cp -r public .next/standalone/public 2>/dev/null || true

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE ${PORT}

CMD ["node", ".next/standalone/server.js"]

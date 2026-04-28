# Dockerfile for agent-api
#
# Railway configuration:
#   - Root Directory: EMPTY (repo root is the build context)
#   - RAILWAY_DOCKERFILE_PATH variable: agent-api/Dockerfile
#   - Start Command: (not needed — CMD is in this Dockerfile)
#
# This gives us access to both agent-api/ and shared/python/ during build.

FROM python:3.12-slim

WORKDIR /app

# System deps for asyncpg (needs pg_config headers at build time)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy shared contracts first (changes less often → better layer caching)
COPY shared/python /app/shared-python

# Copy agent-api code
COPY agent-api/requirements.txt /app/requirements.txt
COPY agent-api/app /app/app

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -e /app/shared-python

# Default port (Railway overrides via $PORT)
ENV PORT=8000

EXPOSE ${PORT}

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

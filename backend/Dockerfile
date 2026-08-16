# API TIER  (Sevalla today, Hostinger VPS later - this image works on both)
#
# LibreOffice has been REMOVED from this image on purpose:
#   - it added ~700MB, making every deploy and every autoscale event slow
#   - it is only needed for DOCX -> PDF conversion, which now runs on the
#     worker tier (see Dockerfile.worker)
#
# Result: a small image that starts in seconds, so scaling out during an exam
# rush is fast instead of taking minutes.

FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
# npm ci = reproducible installs from the lockfile; skip dev deps in the image.
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:20-slim AS runtime

# tini gives correct signal handling, so SIGTERM actually reaches Node and the
# graceful shutdown (drain in-flight requests, close the PG pool) really runs.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
# Cap the heap so the container is OOM-killed predictably instead of thrashing.
ENV NODE_OPTIONS="--max-old-space-size=768"

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Don't run as root.
USER node

EXPOSE 8080

# Container health check. Sevalla, plain Docker, and Hostinger+Coolify all read this.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

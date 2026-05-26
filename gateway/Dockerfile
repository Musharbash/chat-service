# Multi-stage build. Build context is the /backend monorepo root so we can
# pull the local `shared` workspace package into node_modules.

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first for layer caching.
COPY package.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/

# Install all workspace deps. npm understands the workspaces declared in root package.json.
RUN npm install --workspaces --include-workspace-root

# Copy sources and build shared first, then gateway.
COPY shared/ shared/
COPY gateway/ gateway/
RUN npm -w @artook/chat-shared run build \
 && npm -w @artook/chat-gateway run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root user, smaller surface.
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json shared/package.json
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/gateway/package.json gateway/package.json
COPY --from=builder /app/gateway/dist gateway/dist
COPY --from=builder /app/node_modules ./node_modules

USER app
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1
CMD ["node", "gateway/dist/index.js"]

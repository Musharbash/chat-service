FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN npm install --workspaces --include-workspace-root
COPY shared/ shared/
COPY api/ api/
RUN npm -w @artook/chat-shared run build \
 && npm -w @artook/chat-api run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json shared/package.json
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/api/package.json api/package.json
COPY --from=builder /app/api/dist api/dist
COPY --from=builder /app/node_modules ./node_modules
USER app
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:4100/healthz || exit 1
CMD ["node", "api/dist/index.js"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY shared/package.json shared/
COPY worker/package.json worker/
RUN npm install --workspaces --include-workspace-root
COPY shared/ shared/
COPY worker/ worker/
RUN npm -w @artook/chat-shared run build \
 && npm -w @artook/chat-worker run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json shared/package.json
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/worker/package.json worker/package.json
COPY --from=builder /app/worker/dist worker/dist
COPY --from=builder /app/node_modules ./node_modules
USER app
EXPOSE 4200
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:4200/healthz || exit 1
CMD ["node", "worker/dist/index.js"]

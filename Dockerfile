FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3080
ENV FORGE_DATA_DIR=/data
ENV FORGE_WORKSPACE_ROOT=/workspace
ENV FORGE_SANDBOX_MODE=workspace-write

RUN apt-get update && apt-get install -y --no-install-recommends git python3 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

RUN mkdir -p /data /workspace
EXPOSE 3080
CMD ["node", "dist-server/server/index.js"]

# syntax=docker/dockerfile:1

# node:24+ required by @mspstack/mcp-gateway (see package.json engines)
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# markitdown-mcp is Python/pip-only (no npm package); bundling it here removes
# the host-side "pip install markitdown-mcp" dependency entirely.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages markitdown-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY docker ./docker
EXPOSE 8080 3100 9749
CMD ["node", "dist/gateway.js"]

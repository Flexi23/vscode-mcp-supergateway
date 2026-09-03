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
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"
# The semantic bridge resolves Roslyn graphs inside the gateway container, so the
# runtime image must include the .NET SDK as well as the Node/Python tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-pip ffmpeg \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/microsoft-prod.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-10.0 \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages markitdown-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY docker ./docker
EXPOSE 8080 3100
CMD ["node", "dist/gateway.js"]

FROM runtime AS test
ENV NODE_ENV=test
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY resolver.test.mjs ./
CMD ["node", "--test", "resolver.test.mjs"]

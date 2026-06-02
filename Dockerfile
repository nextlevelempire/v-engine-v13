# V-Engine Dockerfile (v0.3)
# Multi-stage build: install + build, then runtime with just the artifacts.

# ---- Stage 1: deps + build ----
FROM node:22-bookworm-slim AS build

# System deps for Playwright (Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libgcc-s1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
    libxss1 libxtst6 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile + package.json first for layer caching
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate && pnpm install --frozen-lockfile

# Copy the rest and build
COPY tsconfig.json tsconfig.client.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN pnpm run build:server

# ---- Stage 2: runtime ----
FROM node:22-bookworm-slim AS runtime

# Same Chromium runtime deps, no build tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libgcc-s1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
    libxss1 libxtst6 wget xdg-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY V-ENGINE.md README.md ./

# Non-root user
RUN useradd -m -u 1001 omni && chown -R omni:omni /app
USER omni

ENV NODE_ENV=production \
    OMNI_LISTEN_HOST=0.0.0.0 \
    OMNI_PORT=4011 \
    OMNI_HOME=/data

EXPOSE 4011

# Healthcheck uses the K8s-style /livez probe (no auth).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4011/livez || exit 1

# tini reaps zombies (Playwright / Chrome child processes)
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "dist/src/cli.js", "serve"]

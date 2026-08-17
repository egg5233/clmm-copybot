# Bot image — also used for the one-shot migrate service, which needs the same
# node_modules (node-pg-migrate) and the migrations/ directory.
FROM node:20-slim

# The Solana SDK stack pulls native deps that expect a C toolchain at install time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first: this layer only rebuilds when dependencies change, not on
# every source edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
COPY public ./public

# Written by the bot at runtime for the files that stay on disk (token-names.json,
# tvl-cache.json) — see docs/postgres-migration.md.
RUN mkdir -p /app/data

ENV NODE_ENV=production

CMD ["npx", "ts-node", "src/index.ts"]

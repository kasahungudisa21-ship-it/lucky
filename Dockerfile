# ላኪ · draw portal — always-on image
# Build:  docker build -t lucky-portal .
# Run:    docker compose up -d        (reads .env, keeps the database in ./data)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# every dependency stays installed: prisma and tsx are needed again at start-up
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
# Prisma's query engine talks to OpenSSL
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/data/lucky.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# the file was written on Windows, where git may not carry the executable bit
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# the entrypoint pushes the schema, seeds the houses and execs the server
ENTRYPOINT ["docker-entrypoint.sh"]

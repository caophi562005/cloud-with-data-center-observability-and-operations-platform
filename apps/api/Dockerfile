# Linux/amd64 Node 24 base resolved before build; no runtime secrets at build time.
FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml ./
# Dependency lifecycle hooks are disabled; Prisma generation is explicit below.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused pnpm exec prisma generate \
    && pnpm run build \
    && pnpm prune --prod \
    && node --input-type=module -e "await import('@prisma/client'); await import('@prisma/adapter-pg')"

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

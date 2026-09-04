FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS production-dependencies

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runner

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production
ENV HOME=/home/node
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=production-dependencies /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY package.json ./package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY scripts/bootstrap-container-config.mjs ./scripts/bootstrap-container-config.mjs

USER node
CMD ["sh", "-c", "node scripts/bootstrap-container-config.mjs && exec tail -f /dev/null"]

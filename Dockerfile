# syntax=docker/dockerfile:1.7
FROM node:24.21.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.7.0 --activate
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
ENV NODE_ENV=production \
    MAILDOCK_ENV=production \
    APP_ORIGIN=https://build.invalid \
    POSTGRES_PASSWORD=build-only-placeholder \
    ATTACHMENTS_PATH=/tmp/maildock-attachments
RUN AUTH_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")" \
    CREDENTIALS_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")" \
    pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# A fresh artifact avoids retaining the build installation's virtual store.
# pnpm >=12.7 also excludes dev-provided optional peers from frozen prod installs.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MAILDOCK_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MAILDOCK_ROLE=all
WORKDIR /app
RUN groupadd --system --gid 1001 maildock \
    && useradd --system --uid 1001 --gid maildock maildock \
    && mkdir -p /var/lib/maildock/attachments \
    && chown -R maildock:maildock /var/lib/maildock
COPY --from=production-dependencies --chown=maildock:maildock /app/node_modules ./node_modules
# Use the explicit production dependency artifact, not standalone's traced copy
# of the build dependency tree (which can reintroduce build-only packages).
COPY --from=build --chown=maildock:maildock /app/.next/standalone/server.js ./server.js
COPY --from=build --chown=maildock:maildock /app/.next/standalone/package.json ./package.json
COPY --from=build --chown=maildock:maildock /app/.next/standalone/.next ./.next
COPY --from=build --chown=maildock:maildock /app/.next/static ./.next/static
COPY --from=build --chown=maildock:maildock /app/public ./public
COPY --from=build --chown=maildock:maildock /app/dist-worker ./dist-worker
COPY --from=build --chown=maildock:maildock /app/db ./db
COPY --from=build --chown=maildock:maildock /app/scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
COPY --from=build --chown=maildock:maildock /app/scripts/postgres/maildock-restore-compatibility.sh ./scripts/postgres/maildock-restore-compatibility.sh
COPY --from=build --chown=maildock:maildock /app/scripts/postgres/recovery ./scripts/postgres/recovery
USER maildock
EXPOSE 3000
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]

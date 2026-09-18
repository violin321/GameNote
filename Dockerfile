# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.23.2

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ARG OCI_REVISION=unknown
ENV APP_REVISION=${OCI_REVISION}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:docker

FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ARG APP_UID=10001
ARG APP_GID=10001
ARG OCI_REVISION=unknown
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.title="GameNote NS2" \
  org.opencontainers.image.source="https://github.com/violin321/GameNote" \
  org.opencontainers.image.revision="${OCI_REVISION}" \
  org.opencontainers.image.version="${APP_VERSION}"
ENV NODE_ENV=production
ENV APP_REVISION=${OCI_REVISION}
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV APP_DATABASE_FILE=/data/ns2.sqlite
ENV MOON_SIDECAR_DIRECTORY=/data/moon
ENV MOON_SIDECAR_SOCKET_PATH=/data/moon/run/sidecar.sock
ENV MOON_SIDECAR_API_KEY_FILE=/data/moon/secrets/api-key
ENV MOON_AUTO_SYNC_ENABLED=1
ENV MOON_SCHEDULER_STATE_FILE=/data/moon/state/app-scheduler.sqlite
ENV NINTENDO_STORE_PROBE_DIR=/data/nintendo-store
ENV NINTENDO_STORE_AUTO_SYNC_ENABLED=1
ENV NINTENDO_STORE_SCHEDULER_STATE_FILE=/data/nintendo-store/scheduler.sqlite

RUN addgroup -S -g ${APP_GID} nodejs \
  && adduser -S -D -H -u ${APP_UID} -G nodejs nextjs \
  && mkdir -p /data \
  && chown nextjs:nodejs /data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/services/moon-sidecar ./services/moon-sidecar
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0555 /usr/local/bin/docker-entrypoint.sh

USER nextjs:nodejs
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node scripts/container-health.mjs
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

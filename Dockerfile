# Single container: API + built web app. Needs DATABASE_URL and ENCRYPTION_KEY at runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ARG APP_VERSION=dev
# pg_dump / pg_restore for scheduled backups (client 18 can back up Postgres 13–18; Railway currently provisions 18).
RUN echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL --http1.1 --retry 5 --retry-delay 3 --retry-all-errors -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
# Uploaded documents and backups go to /data (mount a volume there, or use S3/Azure storage).
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data
ENV UPLOAD_DIR=/data/uploads BACKUP_DIR=/data/backups MIGRATE_ON_START=true TRUST_PROXY=true DEV_SHOW_OTP=false PORT=4000 APP_VERSION=${APP_VERSION}
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
LABEL org.opencontainers.image.title="VendorGate" org.opencontainers.image.vendor="Integratatech.ai Pvt Ltd" org.opencontainers.image.version="${APP_VERSION}"
# Administration commands: node server/dist/cli.js <command>   (backup, restore, licence, create-workspace, user …)
CMD ["node", "server/dist/index.js"]

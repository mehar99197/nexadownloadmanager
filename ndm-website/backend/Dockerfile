# Nexa website API.
FROM node:20-alpine

# mysql-client provides mysqldump for src/scripts/backup.sh; tini reaps the
# child processes a shell-based backup leaves behind.
RUN apk add --no-cache mysql-client bash tini

WORKDIR /app

# Dependencies first so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Never run the API as root.
RUN addgroup -S nexa && adduser -S nexa -G nexa \
    && mkdir -p /app/backups && chown -R nexa:nexa /app
USER nexa

ENV NODE_ENV=production
EXPOSE 3001

# The app exposes /api/health; compose uses it as the readiness gate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]

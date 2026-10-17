FROM node:24-alpine

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/notifier.db
WORKDIR /app

# No runtime dependencies: nothing to install, Node runs the TypeScript sources directly.
COPY package.json ./
COPY src ./src

# Persistent state (SQLite database and backups) lives on a volume mounted at /data.
RUN mkdir -p /data/backups && chown -R node:node /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

# node:sqlite is still experimental and prints a warning on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]

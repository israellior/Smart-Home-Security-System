# The API and the signaling socket, as one image.
#
# Built for linux/arm64 in CI (the server is a Graviton t4g), and builds
# unchanged for amd64 on a laptop - there are no native modules here,
# bcryptjs included, so nothing in node_modules is architecture-specific.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, in their own layer, so a code-only change reuses
# the installed node_modules instead of reinstalling on every build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
# The operational scripts ship too. mint-device and the migrations have
# to run against the production database, and the one place that can
# reach it - allowlisted, with the production secrets in its environment -
# is this container: `docker compose exec api node scripts/mint-device.mjs`.
COPY scripts ./scripts

# The official image ships this unprivileged user. Nothing here needs
# root, and a compromised process that is not root cannot rewrite its
# own code in the image.
USER node

EXPOSE 4000

# busybox wget, because the alpine image has no curl. The port only opens
# once Mongo is connected and the indexes exist (server.js), so "healthy"
# means the database was reachable, not just that Node started.
#
# --start-interval polls every 3s while booting, so a deploy learns the
# new release is up in seconds instead of waiting out a 30s interval.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --start-interval=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health > /dev/null || exit 1

CMD ["node", "server.js"]

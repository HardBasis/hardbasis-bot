# hardbasis-bot — built ON the box straight from this public repo, the way an
# outside trader would. Every deploy therefore dogfoods the README.
FROM node:22-alpine

# corepack ships with node:22 and pins pnpm from package.json's packageManager.
RUN corepack enable

WORKDIR /app

# Install deps first for layer caching.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod=false --frozen-lockfile || pnpm install --prod=false

# App source (state/ and logs/ are volumes, never baked in; see .dockerignore).
COPY tsconfig.json vitest.config.ts ./
COPY spec ./spec
COPY src ./src
COPY scripts ./scripts

# Run as the unprivileged built-in `node` user; it owns the state/logs volumes.
RUN mkdir -p /app/state /app/logs && chown -R node:node /app
USER node

ENV HB_STATE_DIR=/app/state \
    HB_LOG_DIR=/app/logs \
    NODE_ENV=production

# tsx runs the TypeScript directly (ADR-parity with the monorepo's tsx runtime).
CMD ["pnpm", "start"]

# =============================================================================
# Dockerfile for the Nakama server with our compiled JS modules baked in.
#
# We use a multi-stage build:
#
#   Stage 1 (builder): Node 20 image. Installs npm deps, runs `npm run build`
#                      which type-checks the TS, bundles via rollup, and
#                      copies the result into data/modules/index.js.
#
#   Stage 2 (runtime): heroiclabs/nakama:3.22.0. Copies just the data
#                      directory (containing local.yml + modules/index.js)
#                      into the image. The container is otherwise unchanged
#                      from the stock Nakama image.
#
# This setup means a `docker build` produces a self-contained image that can
# be deployed anywhere — no separate runtime-mounted volume needed for the JS
# bundle. (We still bind-mount data/ in dev for fast iteration; see
# docker-compose.yml.)
# =============================================================================

# ---- Stage 1: build TypeScript modules --------------------------------------
FROM node:20-alpine AS builder

WORKDIR /build

# Copy only the files needed for `npm install` first so Docker can cache the
# dependency layer when only source files change.
COPY package.json ./
# package-lock.json may not exist on first run; copy it conditionally with a
# wildcard so the build doesn't fail.
COPY package-lock.json* ./
RUN npm install --no-audit --no-fund

# Now copy the source files and config and build.
COPY tsconfig.json rollup.config.mjs ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime image -------------------------------------------------
# Pin the Nakama version explicitly. Bumping is a deliberate decision —
# don't use `latest`.
FROM heroiclabs/nakama:3.22.0

# Copy the local.yml config and the compiled modules into the image.
# Nakama expects modules under /nakama/data/modules; we mirror that layout.
COPY --from=builder /build/data/modules /nakama/data/modules
COPY local.yml /nakama/data/local.yml

# The image already has Nakama as ENTRYPOINT. We override CMD to include
# our config file path. The migrate step is run separately by docker-compose
# (see depends_on / command in docker-compose.yml).
CMD ["/nakama/nakama", "--config", "/nakama/data/local.yml"]

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

# Copy the entrypoint script that handles `migrate up` then starts Nakama
# using whichever DATABASE_URL was injected by the host (Render, Railway,
# Fly.io, etc.). Same script also works locally with docker-compose if you
# pass DATABASE_URL — though docker-compose still has its own entrypoint
# override that runs migrate explicitly. Belt and suspenders.
COPY entrypoint.sh /nakama/entrypoint.sh
# Nakama base image is alpine-based; chmod is needed because COPY doesn't
# preserve the executable bit on Windows hosts.
USER root
RUN chmod +x /nakama/entrypoint.sh
USER root

# The Nakama base image sets ENTRYPOINT to the nakama binary; override it so
# our shell script runs instead. The script then execs nakama as PID 1.
ENTRYPOINT ["/nakama/entrypoint.sh"]

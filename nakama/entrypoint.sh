#!/bin/sh
# =============================================================================
# Nakama container entrypoint.
#
# Responsibilities:
#   1. Resolve the database connection string from the environment. Hosting
#      providers all use slightly different conventions:
#        - Render injects DATABASE_URL on the linked Postgres
#        - Railway injects DATABASE_URL on the Postgres add-on
#        - Fly.io uses DATABASE_URL too if you `fly postgres attach`
#        - Heroku uses DATABASE_URL
#      So DATABASE_URL is the lingua franca. We accept it as-is, OR fall back
#      to NAKAMA_DATABASE_ADDRESS for compatibility with the Nakama-native
#      `user:pass@host:port/db` shorthand.
#   2. Run `nakama migrate up` against that database (idempotent — Nakama
#      tracks schema versions in a `_migration` table).
#   3. exec the nakama server, replacing this shell so signals propagate
#      cleanly to PID 1.
#
# Optional env vars (all have sensible defaults):
#   PORT                       Port the HTTP API binds to. Defaults to 7350.
#                              Render automatically injects this — Nakama must
#                              respect it for the health probe to pass.
#   NAKAMA_HTTP_KEY            Runtime HTTP key for RPCs. Override in prod.
#   NAKAMA_SOCKET_SERVER_KEY   Server key shared with the client. Override too.
#   NAKAMA_SESSION_KEY         Session encryption key. >=32 chars random.
#   NAKAMA_REFRESH_KEY         Refresh token encryption key. >=32 chars random.
#   NAKAMA_CONSOLE_USERNAME    Admin console username. Default: admin
#   NAKAMA_CONSOLE_PASSWORD    Admin console password. Override in prod.
# =============================================================================

set -e

# ---- 1. Resolve DB address --------------------------------------------------
DB="${NAKAMA_DATABASE_ADDRESS:-${DATABASE_URL:-}}"
if [ -z "$DB" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL (or NAKAMA_DATABASE_ADDRESS) is not set."
  echo "[entrypoint]   Render: link a PostgreSQL service in render.yaml — it"
  echo "[entrypoint]           will automatically inject DATABASE_URL."
  echo "[entrypoint]   Railway: add a PostgreSQL plugin and reference"
  echo "[entrypoint]            \${{Postgres.DATABASE_URL}} in service vars."
  echo "[entrypoint]   Local docker-compose: see docker-compose.yml — it sets"
  echo "[entrypoint]            the connection string explicitly."
  exit 1
fi

# ---- 2. Apply optional env-driven config defaults ---------------------------
PORT="${PORT:-7350}"
HTTP_KEY="${NAKAMA_HTTP_KEY:-defaulthttpkey}"
SOCKET_SERVER_KEY="${NAKAMA_SOCKET_SERVER_KEY:-defaultkey}"
SESSION_KEY="${NAKAMA_SESSION_KEY:-defaultsessionkeydefaultsessionkey}"
REFRESH_KEY="${NAKAMA_REFRESH_KEY:-defaultrefreshkeydefaultrefreshkey}"
CONSOLE_USERNAME="${NAKAMA_CONSOLE_USERNAME:-admin}"
CONSOLE_PASSWORD="${NAKAMA_CONSOLE_PASSWORD:-changeme}"

echo "[entrypoint] DATABASE_URL is set ($(echo "$DB" | sed 's/:[^:@]*@/:***@/'))"
echo "[entrypoint] Listening on port $PORT"

# ---- 3. Run migrations ------------------------------------------------------
# `migrate up` is idempotent: it reads the current schema version from a
# tracking table and only applies missing migrations. Safe to run on every
# container start.
echo "[entrypoint] Running database migrations..."
/nakama/nakama migrate up --database.address "$DB"

# ---- 4. Start Nakama --------------------------------------------------------
# We bind to 0.0.0.0 so the host platform's load balancer can reach us. The
# `exec` makes nakama become PID 1 so it receives SIGTERM directly when the
# host shuts the container down (graceful exit, no zombie processes).
echo "[entrypoint] Starting Nakama..."
exec /nakama/nakama \
  --config /nakama/data/local.yml \
  --database.address "$DB" \
  --socket.address 0.0.0.0 \
  --socket.port "$PORT" \
  --socket.server_key "$SOCKET_SERVER_KEY" \
  --runtime.http_key "$HTTP_KEY" \
  --session.encryption_key "$SESSION_KEY" \
  --session.refresh_encryption_key "$REFRESH_KEY" \
  --console.address 0.0.0.0 \
  --console.username "$CONSOLE_USERNAME" \
  --console.password "$CONSOLE_PASSWORD"

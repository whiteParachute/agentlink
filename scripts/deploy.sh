#!/usr/bin/env bash
# Agentlink minimal deployment helper.
#
# This is intentionally small and safe: it validates configuration, prepares the
# build, and (optionally) starts the server. It is NOT a process supervisor and
# does not use Docker/systemd/PM2. It never applies migrations to a business
# database unless AGENTLINK_DEPLOY_APPLY_MIGRATION=1 is explicitly set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="start"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Agentlink deploy helper

Usage:
  scripts/deploy.sh [mode] [options]

Modes:
  start            Validate config, install/build/check, then exec `npm start` (default).
  check            Validate config and run install/build/check/db:smoke only. Does NOT start the server.
  print-command    Print the resolved startup command and a redacted config summary. Does NOT start the server.

Options:
  --dry-run        Same as print-command: never installs, builds, or starts anything.
  --env-file PATH  Load environment from PATH (default: $AGENTLINK_ENV_FILE or .env if present).
  -h, --help       Show this help.

Environment validation:
  * Node.js >= 22 is required.
  * AGENTLINK_STORAGE=postgres requires AGENTLINK_DATABASE_URL.
  * NODE_ENV=production requires AGENTLINK_SOURCE_HASH_SECRET and AGENTLINK_INGRESS_BEARER_TOKEN.

Safety:
  * Secrets/tokens/database URLs are never printed in full.
  * Migrations are NOT applied automatically. Set AGENTLINK_DEPLOY_APPLY_MIGRATION=1 (requires psql)
    to opt in; otherwise run migrations manually. Prefer `db:smoke` for verification.
  * Not a Docker/systemd/PM2 supervisor; it execs a single foreground `npm start`.
USAGE
}

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Redact a sensitive value: show only whether it is set, never the value.
redact() {
  if [ -n "${1:-}" ]; then printf 'set (redacted)'; else printf '(unset)'; fi
}

ENV_FILE="${AGENTLINK_ENV_FILE:-}"

# Parse arguments. The first non-option token selects the mode.
mode_set=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --env-file)
      [ "$#" -ge 2 ] || fail "--env-file requires a path"
      ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#*=}"; shift ;;
    start|check|prepare|print-command|dry-run)
      MODE="$1"; mode_set=1; shift ;;
    *) fail "Unknown argument: $1 (try --help)" ;;
  esac
done

# Normalize aliases.
case "$MODE" in
  prepare) MODE="check" ;;
  dry-run) MODE="print-command" ;;
esac
if [ "$DRY_RUN" -eq 1 ]; then MODE="print-command"; fi

# Default env file is .env when present (optional).
if [ -z "$ENV_FILE" ] && [ -f "$REPO_ROOT/.env" ]; then ENV_FILE="$REPO_ROOT/.env"; fi

if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || fail "Env file not found: $ENV_FILE"
  log "Loading env file: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# --- Configuration validation -------------------------------------------------

check_node_version() {
  command -v node >/dev/null 2>&1 || fail "node is not installed (Node.js >= 22 required)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    fail "Node.js >= 22 required, found $(node -v)"
  fi
  log "Node.js $(node -v) OK"
}

validate_config() {
  local storage="${AGENTLINK_STORAGE:-memory}"
  log "Storage mode: $storage"
  if [ "$storage" = "postgres" ] && [ -z "${AGENTLINK_DATABASE_URL:-}" ]; then
    fail "AGENTLINK_STORAGE=postgres requires AGENTLINK_DATABASE_URL"
  fi
  if [ "${NODE_ENV:-}" = "production" ]; then
    [ -n "${AGENTLINK_SOURCE_HASH_SECRET:-}" ] || fail "NODE_ENV=production requires AGENTLINK_SOURCE_HASH_SECRET"
    [ -n "${AGENTLINK_INGRESS_BEARER_TOKEN:-}" ] || fail "NODE_ENV=production requires AGENTLINK_INGRESS_BEARER_TOKEN"
  fi
}

config_summary() {
  cat <<SUMMARY >&2
[deploy] config summary:
  NODE_ENV                       = ${NODE_ENV:-(unset)}
  AGENTLINK_HOST                 = ${AGENTLINK_HOST:-0.0.0.0}
  AGENTLINK_PORT                 = ${AGENTLINK_PORT:-8080}
  AGENTLINK_STORAGE              = ${AGENTLINK_STORAGE:-memory}
  AGENTLINK_DATABASE_URL         = $(redact "${AGENTLINK_DATABASE_URL:-}")
  AGENTLINK_SOURCE_HASH_SECRET   = $(redact "${AGENTLINK_SOURCE_HASH_SECRET:-}")
  AGENTLINK_INGRESS_BEARER_TOKEN = $(redact "${AGENTLINK_INGRESS_BEARER_TOKEN:-}")
SUMMARY
}

prepare() {
  log "Installing dependencies (npm ci)"
  ( cd "$REPO_ROOT" && npm ci )
  log "Building (npm run build)"
  ( cd "$REPO_ROOT" && npm run build )
  log "Running checks (npm run check)"
  ( cd "$REPO_ROOT" && npm run check )
  log "Running db:smoke (skips when AGENTLINK_DATABASE_URL is unset)"
  ( cd "$REPO_ROOT" && npm run db:smoke )
}

maybe_apply_migration() {
  if [ "${AGENTLINK_DEPLOY_APPLY_MIGRATION:-0}" = "1" ]; then
    command -v psql >/dev/null 2>&1 || fail "AGENTLINK_DEPLOY_APPLY_MIGRATION=1 requires psql"
    [ -n "${AGENTLINK_DATABASE_URL:-}" ] || fail "Applying migration requires AGENTLINK_DATABASE_URL"
    log "WARNING: applying migrations/0001_initial.sql to the target database"
    psql "${AGENTLINK_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/migrations/0001_initial.sql"
  fi
}

# --- Main ---------------------------------------------------------------------

check_node_version
validate_config
config_summary

case "$MODE" in
  print-command)
    log "Resolved startup command: npm start"
    ;;
  check)
    prepare
    log "check complete; server not started"
    ;;
  start)
    prepare
    maybe_apply_migration
    log "Starting server: npm start"
    cd "$REPO_ROOT"
    exec npm start
    ;;
  *)
    fail "Unknown mode: $MODE (try --help)"
    ;;
esac

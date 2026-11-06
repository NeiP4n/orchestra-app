#!/usr/bin/env bash
# Orchestra server watchdog (B14 live fix, 2026-11-06).
#
# The live server died SILENTLY (no error in the log, no readable OOM trace)
# and nothing noticed until an operator looked. This script is the outside
# eye: it runs `orchestra serve`, and when the server exits it decides from
# the lifecycle state file whether to restart it.
#
#   clean shutdown (marker in server-state.json) .... stop, exit 0.
#   lock held by a live pid ....................... another server took
#                                                    over; stop, exit 0.
#   anything else (SIGKILL, crash, OOM) ............ restart with backoff.
#
# Backoff is 5s, 10s, 20s, 40s, then 60s; after ORCHESTRA_WATCHDOG_MAX_RESTARTS
# (default 5) failed restarts it gives up loudly (exit 1) instead of
# spinning a crash loop. A restart only counts as failed when the server
# exits uncleanly again; a clean shutdown resets the counter to zero.
#
# Usage (from the repo root of the worktree the server should run from):
#   scripts/server-watchdog.sh [--data-dir DIR] [--max-restarts N]
#                              [--backoff-base SECONDS] [--log FILE]
#                              [--port PORT] -- [extra `serve` args...]
#
# The serve command is `bun packages/cli/src/index.ts serve "$@"` so the
# watchdog runs the worktree's own code; pass --port to serve through the
# extra args as usual. ORCHESTRA_CONFIG_DIR / ORCHESTRA_DATA_DIR /
# ORCHESTRA_PASSWORD are inherited from the environment, exactly as for a
# manual `orchestra serve`. The data directory defaults to
# $ORCHESTRA_DATA_DIR, else ~/.local/share/orchestra.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ORCHESTRA_DATA_DIR:-$HOME/.local/share/orchestra}"
MAX_RESTARTS="${ORCHESTRA_WATCHDOG_MAX_RESTARTS:-5}"
BACKOFF_BASE="${ORCHESTRA_WATCHDOG_BACKOFF_BASE:-5}"
LOG_FILE=""
SERVE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --max-restarts) MAX_RESTARTS="$2"; shift 2 ;;
    --backoff-base) BACKOFF_BASE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --) shift; SERVE_ARGS+=("$@"); break ;;
    *) SERVE_ARGS+=("$1"); shift ;;
  esac
done
[ -n "$LOG_FILE" ] || LOG_FILE="$DATA_DIR/watchdog.log"

mkdir -p "$DATA_DIR" 2>/dev/null || true

log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [watchdog] $*"
  echo "$line"
  echo "$line" >>"$LOG_FILE" 2>/dev/null || true
}

# Reads one field out of the lifecycle state file with bun (no jq dependency).
# Prints nothing when the file is missing or unreadable.
state_field() {
  [ -f "$DATA_DIR/server-state.json" ] || return 0
  bun -e '
    const fs = require("node:fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const field = process.argv[2];
      const value = field === "cleanShutdown" ? s.cleanShutdown : s[field];
      if (value !== undefined) console.log(String(value));
    } catch { /* unreadable state: treated as unknown by the caller */ }
  ' "$DATA_DIR/server-state.json" "$1" 2>/dev/null || true
}

# Is any lock file in the data dir held by a live process?
live_lock_holder() {
  for lock in "$DATA_DIR"/server.lock "$DATA_DIR"/server-*.lock; do
    [ -f "$lock" ] || continue
    local pid
    pid="$(bun -e '
      const fs = require("node:fs");
      try { console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).pid); } catch {}
    ' "$lock" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid ($lock)"
      return 0
    fi
  done
  return 1
}

backoff_for() {
  local attempt="$1" delay="$BACKOFF_BASE"
  local i=1
  while [ "$i" -lt "$attempt" ]; do delay=$((delay * 2)); i=$((i + 1)); done
  [ "$delay" -gt 60 ] && delay=60
  echo "$delay"
}

log "starting; data dir $DATA_DIR; max restarts $MAX_RESTARTS; serve args: ${SERVE_ARGS[*]:-(none)}"
failures=0
while true; do
  log "starting server (attempt $((failures + 1)))"
  (cd "$ROOT" && bun packages/cli/src/index.ts serve "${SERVE_ARGS[@]}")
  code=$?
  log "server exited with code $code"

  clean="$(state_field cleanShutdown)"
  if [ "$clean" = "true" ]; then
    log "clean shutdown marker present; not restarting."
    exit 0
  fi

  holder="$(live_lock_holder || true)"
  if [ -n "$holder" ]; then
    log "lock is held by a live server ($holder); another server took over; not restarting."
    exit 0
  fi

  failures=$((failures + 1))
  if [ "$failures" -gt "$MAX_RESTARTS" ]; then
    log "gave up after $MAX_RESTARTS unclean restarts; last exit code $code. Fix the server before starting it again."
    exit 1
  fi
  delay="$(backoff_for "$failures")"
  log "unclean exit (no clean-shutdown marker); restarting in ${delay}s (failure $failures/$MAX_RESTARTS)."
  sleep "$delay"
done

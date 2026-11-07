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
# (default 5) unclean restarts inside ORCHESTRA_WATCHDOG_WINDOW_SECONDS
# (default 600) it gives up loudly (exit 1) instead of spinning a crash
# loop. The cap is a sliding window, not a lifetime count: a server that
# crashes once an hour forever never trips it, while 6 crashes in 10 minutes
# stop the loop. A restart only counts when the server exits uncleanly
# again; a clean shutdown stops the watchdog (exit 0).
#
# A lock is only "held by a live server" when the pid in it is alive AND
# started at the lock's startedAt time: a bare kill -0 cannot tell a live
# server from an unrelated process that recycled the pid. When the start
# time cannot be verified (old lock, no /proc, no ps) the watchdog falls
# back to kill -0 and logs that the check was unverified.
#
# Autostart safety (2026-11-07, watchdog-autostart): the watchdog is also
# the unit that systemd starts at boot (see
# scripts/orchestra-watchdog.service and scripts/install-watchdog-autostart.sh).
# Two guards keep a second watchdog — manual or autostarted — from ever
# starting a second server next to a live one:
#
#   * single instance: a flock on $DATA_DIR/watchdog.lock, held for the
#     watchdog's whole lifetime. A second watchdog exits 0 at once. The
#     lock is released by the kernel when the holder dies, so a stale file
#     after a crash or a reboot never blocks the next start. When `flock`
#     is not installed the guard is skipped with a loud log line instead of
#     failing the watchdog (the pre-flight check below still applies).
#   * pre-flight: before the first `serve` start, a live lock holder
#     means a server is already running, so the watchdog exits 0 without
#     starting anything. (Previously a second watchdog spawned a second
#     `serve` that only failed fast with ServerAlreadyRunningError.)
#
# `--probe` is the read-only form of the same check, for the installer and
# for operators: it prints the live holder (`pid (lock file)`) and exits 0
# when a server is running, exits 1 otherwise, and never starts a server
# or takes the watchdog lock.
#
# Usage (from the repo root of the worktree the server should run from):
#   scripts/server-watchdog.sh [--data-dir DIR] [--max-restarts N]
#                              [--window-seconds N] [--backoff-base SECONDS]
#                              [--log FILE] [--probe] -- [extra `serve` args...]
#
# The serve command is `$BUN packages/cli/src/index.ts serve "$@"` so the
# watchdog runs the worktree's own code; pass --port to serve through the
# extra args as usual. $BUN is resolved once at startup (see resolve_bun
# below): systemd runs this script with a minimal PATH that has no bun in
# it, so a bare `bun` here failed with exit code 127 on every start.
# ORCHESTRA_BUN overrides the resolution with an explicit bun path.
# ORCHESTRA_CONFIG_DIR / ORCHESTRA_DATA_DIR /
# ORCHESTRA_PASSWORD are inherited from the environment, exactly as for a
# manual `orchestra serve`. The data directory defaults to
# $ORCHESTRA_DATA_DIR, else ~/.local/share/orchestra.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ORCHESTRA_DATA_DIR:-$HOME/.local/share/orchestra}"
MAX_RESTARTS="${ORCHESTRA_WATCHDOG_MAX_RESTARTS:-5}"
WINDOW_SECONDS="${ORCHESTRA_WATCHDOG_WINDOW_SECONDS:-600}"
BACKOFF_BASE="${ORCHESTRA_WATCHDOG_BACKOFF_BASE:-5}"
LOG_FILE=""
PROBE=0
SERVE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --max-restarts) MAX_RESTARTS="$2"; shift 2 ;;
    --window-seconds) WINDOW_SECONDS="$2"; shift 2 ;;
    --backoff-base) BACKOFF_BASE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --probe) PROBE=1; shift ;;
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

# Resolve bun once, up front: systemd runs this script with a minimal
# PATH that has no bun in it, so a bare `bun` failed with exit code 127
# on every start from the unit (2026-11-07) while the interactive shell
# worked. Order: explicit ORCHESTRA_BUN, then `command -v bun`, then
# known install locations. A set-but-unusable ORCHESTRA_BUN fails
# loudly instead of silently falling through to a different bun.
resolve_bun() {
  if [ -n "${ORCHESTRA_BUN:-}" ]; then
    # >&2: resolve_bun runs inside $(...) to capture the path, so a plain
    # log line here would be swallowed into the captured output instead
    # of reaching the terminal. The log-file append inside log() still runs.
    [ -x "$ORCHESTRA_BUN" ] || { log "ORCHESTRA_BUN is set but not executable: $ORCHESTRA_BUN" >&2; return 1; }
    echo "$ORCHESTRA_BUN"
    return 0
  fi
  local found
  found="$(command -v bun 2>/dev/null || true)"
  if [ -n "$found" ] && [ -x "$found" ]; then
    echo "$found"
    return 0
  fi
  local candidate
  for candidate in /opt/hatch-image/bin/bun "${HOME:-}/.bun/bin/bun" /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

BUN="$(resolve_bun)" || { log "bun not found: not on PATH and not at /opt/hatch-image/bin/bun, \$HOME/.bun/bin/bun or /usr/local/bin/bun (set ORCHESTRA_BUN to its full path). Refusing to run: without bun every serve start would fail with exit code 127."; exit 1; }
log "using bun at $BUN"

# Reads one field out of the lifecycle state file with bun (no jq dependency).
# Prints nothing when the file is missing or unreadable.
state_field() {
  [ -f "$DATA_DIR/server-state.json" ] || return 0
  "$BUN" -e '
    const fs = require("node:fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const field = process.argv[2];
      const value = field === "cleanShutdown" ? s.cleanShutdown : s[field];
      if (value !== undefined) console.log(String(value));
    } catch { /* unreadable state: treated as unknown by the caller */ }
  ' "$DATA_DIR/server-state.json" "$1" 2>/dev/null || true
}

# Reads one field out of a lock file with bun (no jq dependency).
# Prints nothing when the file is missing or unreadable.
lock_field() {
  "$BUN" -e '
    const fs = require("node:fs");
    try {
      const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const value = lock[process.argv[2]];
      if (value !== undefined) console.log(String(value));
    } catch {}
  ' "$1" "$2" 2>/dev/null || true
}

# Epoch seconds when pid started, via /proc (Linux) or `ps` as a fallback.
# Prints nothing when it cannot be determined.
proc_start_epoch() {
  local pid="$1"
  if [ -r "/proc/$pid/stat" ]; then
    local starttime btime hertz
    # comm sits in parens and may contain spaces, so strip through the last
    # ")" first: starttime is then field 20 of what remains.
    starttime="$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')"
    btime="$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null)"
    hertz="$(getconf CLK_TCK 2>/dev/null || echo 100)"
    if [ -n "$starttime" ] && [ -n "$btime" ] && [ -n "$hertz" ]; then
      echo $((btime + starttime / hertz))
      return 0
    fi
  fi
  local lstart
  lstart="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')"
  if [ -n "$lstart" ]; then
    date -d "$lstart" +%s 2>/dev/null
  fi
}

# 0 = pid is alive and started at startedAt (ISO); 1 = dead, or alive but
# started at a different time (the pid was recycled after the lock owner
# died); 2 = cannot verify (no startedAt in the lock, no /proc, no ps, or
# an unparsable lock time).
lock_is_live() {
  local pid="$1" started_at="$2"
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$started_at" ] || return 2
  local lock_epoch proc_epoch diff
  lock_epoch="$(date -d "$started_at" +%s 2>/dev/null)" || return 2
  [ -n "$lock_epoch" ] || return 2
  proc_epoch="$(proc_start_epoch "$pid")"
  [ -n "$proc_epoch" ] || return 2
  diff=$((proc_epoch - lock_epoch))
  [ "${diff#-}" -le 2 ]
}

# Is any lock file in the data dir held by a live process? A pid alone is
# not proof: PIDs get recycled, so the lock's startedAt must match the
# process start time. An unverifiable lock falls back to kill -0, loudly.
# The diagnostic logs inside go to stderr: live_lock_holder's stdout is
# captured by the caller, and a log line there would fake a live holder.
live_lock_holder() {
  for lock in "$DATA_DIR"/server.lock "$DATA_DIR"/server-*.lock; do
    [ -f "$lock" ] || continue
    local pid started_at
    pid="$(lock_field "$lock" pid)"
    started_at="$(lock_field "$lock" startedAt)"
    [ -n "$pid" ] || continue
    lock_is_live "$pid" "$started_at"
    local verdict=$?
    if [ "$verdict" -eq 0 ]; then
      echo "$pid ($lock)"
      return 0
    fi
    if [ "$verdict" -eq 2 ]; then
      log "cannot verify start time for pid $pid ($lock); trusting kill -0 (PID reuse not excluded)." >&2
      echo "$pid ($lock)"
      return 0
    fi
    if kill -0 "$pid" 2>/dev/null; then
      log "stale lock $lock: pid $pid is alive but started at another time (PID reuse); ignoring." >&2
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

# Unclean-exit timestamps (epoch seconds). The restart cap counts failures
# inside WINDOW_SECONDS only: old entries are pruned on record, so a slow
# trickle of crashes never trips the cap while a crash loop does.
FAILURE_TIMES=()

record_failure() {
  # Separate statements: the RHS of one `local` assignment cannot see an
  # earlier one in the same statement (expansions run before any assignment).
  local now="${1:-$(date +%s)}"
  local cutoff=$((now - WINDOW_SECONDS))
  local kept=() t
  for t in "${FAILURE_TIMES[@]}"; do
    [ "$t" -ge "$cutoff" ] && kept+=("$t")
  done
  kept+=("$now")
  FAILURE_TIMES=("${kept[@]}")
}

failures_in_window() {
  local now="${1:-$(date +%s)}"
  local cutoff=$((now - WINDOW_SECONDS))
  local count=0 t
  for t in "${FAILURE_TIMES[@]}"; do
    [ "$t" -ge "$cutoff" ] && count=$((count + 1))
  done
  echo "$count"
}

# --- main loop ---

# Read-only probe: does a live server hold a lock right now? Prints the
# holder (`pid (lock file)`) and exits 0, or exits 1 when no live server
# holds one. Takes no watchdog lock and starts no server, so the installer
# and operators can ask safely while a watchdog is already running.
if [ "$PROBE" = "1" ]; then
  holder="$(live_lock_holder || true)"
  if [ -n "$holder" ]; then
    echo "$holder"
    exit 0
  fi
  exit 1
fi

# Single watchdog instance: a second watchdog (manual, or autostarted
# while one already runs) exits at once instead of spawning a second
# `serve` next to the live one. The lock is held on fd 9 for the
# watchdog's whole lifetime and released by the kernel on death, so a
# stale file after a crash or reboot never blocks the next start.
if command -v flock >/dev/null 2>&1; then
  touch "$DATA_DIR/watchdog.lock" 2>/dev/null || { log "cannot create $DATA_DIR/watchdog.lock; refusing to run without the single-instance guard."; exit 1; }
  exec 9>"$DATA_DIR/watchdog.lock"
  if ! flock -n 9; then
    log "another watchdog already holds $DATA_DIR/watchdog.lock; exiting."
    exit 0
  fi
else
  log "flock not available; single-watchdog guard disabled (the pre-flight live-server check below still applies)."
fi

# Pre-flight: a live lock holder means a server is already running, so
# there is nothing to watch. Exit before starting a duplicate `serve`
# (which would only fail fast with ServerAlreadyRunningError).
holder="$(live_lock_holder || true)"
if [ -n "$holder" ]; then
  log "server already running ($holder); not starting another one."
  exit 0
fi

log "starting; data dir $DATA_DIR; max restarts $MAX_RESTARTS within ${WINDOW_SECONDS}s; serve args: ${SERVE_ARGS[*]:-(none)}"
while true; do
  failures="$(failures_in_window)"
  log "starting server (attempt $((failures + 1)))"
  (cd "$ROOT" && "$BUN" packages/cli/src/index.ts serve "${SERVE_ARGS[@]}")
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

  record_failure
  failures="$(failures_in_window)"
  if [ "$failures" -gt "$MAX_RESTARTS" ]; then
    log "gave up after $failures unclean restarts within ${WINDOW_SECONDS}s (cap $MAX_RESTARTS); last exit code $code. Fix the server before starting it again."
    exit 1
  fi
  delay="$(backoff_for "$failures")"
  log "unclean exit (no clean-shutdown marker); restarting in ${delay}s (failure $failures/$MAX_RESTARTS within ${WINDOW_SECONDS}s)."
  sleep "$delay"
done

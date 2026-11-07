#!/usr/bin/env bash
# Install the Orchestra server-watchdog autostart (systemd unit).
#
# Renders scripts/orchestra-watchdog.service for this machine and installs
# it — user scope by default, system scope with --system. The unit starts
# ONLY the watchdog; the watchdog decides whether the server needs starting
# (flock + pre-flight live-lock check, see scripts/server-watchdog.sh).
#
# Safety rules (the installer never restarts a live server):
#   * it never touches a running server or watchdog: after enabling the
#     unit it starts it ONLY when --probe says no server is live AND the
#     watchdog flock is free. Otherwise it prints "already running" and
#     leaves the unit enabled for the next boot.
#   * it never writes secrets: ORCHESTRA_PASSWORD and friends live in an
#     env file the operator creates mode 0600
#     (%h/.config/orchestra/watchdog.env by default). The installer only
#     tells the operator when that file is missing.
#   * the service user must own the data directory: the state file and the
#     locks are created 0600, so a watchdog running as another user could
#     not read them. A mismatch refuses the install unless --force is given.
#   * an existing unit file is backed up before it is replaced.
#
# This script installs NOTHING on its own in --dry-run / --check mode.
# Running it for real is a deliberate operator action (separate approval).
#
# Usage:
#   scripts/install-watchdog-autostart.sh [--scope user|system]
#     [--worktree DIR] [--data-dir DIR] [--port N] [--hostname HOST]
#     [--serve-args "ARGS"] [--service-user USER] [--env-file PATH]
#     [--dry-run] [--check] [--force]
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/scripts/orchestra-watchdog.service"
WATCHDOG="$ROOT/scripts/server-watchdog.sh"
UNIT_NAME="orchestra-watchdog.service"

SCOPE="user"
WORKTREE="$ROOT"
DATA_DIR="${ORCHESTRA_DATA_DIR:-$HOME/.local/share/orchestra}"
PORT="17890"
HOSTNAME="127.0.0.1"
SERVE_ARGS=""
SERVICE_USER=""
ENV_FILE="%h/.config/orchestra/watchdog.env"
DRY_RUN=0
CHECK=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --hostname) HOSTNAME="$2"; shift 2 ;;
    --serve-args) SERVE_ARGS="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --check) CHECK=1; shift ;;
    --force) FORCE=1; shift ;;
    --help | -h)
      sed -n '2,40p' "${BASH_SOURCE[0]}"
      echo "Usage: $0 [--scope user|system] [--worktree DIR] [--data-dir DIR] [--port N]"
      echo "          [--hostname HOST] [--serve-args \"ARGS\"] [--service-user USER]"
      echo "          [--env-file PATH] [--dry-run] [--check] [--force]"
      exit 0
      ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[ "$SCOPE" = "user" ] || [ "$SCOPE" = "system" ] || { echo "invalid --scope: $SCOPE (user|system)" >&2; exit 2; }
[ -f "$TEMPLATE" ] || { echo "unit template not found: $TEMPLATE" >&2; exit 1; }
[ -f "$WATCHDOG" ] || { echo "watchdog script not found: $WATCHDOG" >&2; exit 1; }
[ -n "$SERVE_ARGS" ] || SERVE_ARGS="--hostname $HOSTNAME --port $PORT"

INVOKING_USER="$(id -un)"
SERVICE_HOME="$(getent passwd "$INVOKING_USER" 2>/dev/null | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] || SERVICE_HOME="$HOME"
DATA_OWNER=""
[ -d "$DATA_DIR" ] && DATA_OWNER="$(stat -c %U "$DATA_DIR" 2>/dev/null || true)"

if [ "$SCOPE" = "system" ]; then
  [ "$(id -u)" = "0" ] || { echo "system scope needs root (run with sudo); use --scope user for a user unit." >&2; exit 1; }
  [ -n "$SERVICE_USER" ] || SERVICE_USER="${DATA_OWNER:-$INVOKING_USER}"
  UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
  WANTED_BY="multi-user.target"
  SYSTEMCTL="systemctl"
else
  SERVICE_USER="$INVOKING_USER"
  UNIT_PATH="$SERVICE_HOME/.config/systemd/user/$UNIT_NAME"
  WANTED_BY="default.target"
  SYSTEMCTL="systemctl --user"
fi

# The service user's home (for %h expansion and the env-file note): in
# system scope it can differ from the invoking user's home.
SERVICE_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] || SERVICE_HOME="$HOME"

# The service user must own the data directory: state/lock files are 0600.
if [ -n "$DATA_OWNER" ] && [ "$DATA_OWNER" != "$SERVICE_USER" ] && [ "$FORCE" = "0" ]; then
  echo "refusing: data directory $DATA_DIR is owned by $DATA_OWNER, but the unit would run as $SERVICE_USER." >&2
  echo "The watchdog could not read the 0600 state/lock files. Re-run as $DATA_OWNER," >&2
  echo "(--scope user as that user, or --system --service-user $DATA_OWNER), or pass --force." >&2
  exit 1
fi

# Render the unit. The @SERVICE_USER@ line exists only for system scope:
# user units may not set User=.
render_unit() {
  local out="$1"
  sed -e "s|@WORKTREE@|$WORKTREE|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
      -e "s|@ENV_FILE@|$ENV_FILE|g" \
      -e "s|@SERVE_ARGS@|$SERVE_ARGS|g" \
      -e "s|@WANTED_BY@|$WANTED_BY|g" \
      "$TEMPLATE" >"$out"
  if [ "$SCOPE" = "system" ]; then
    sed -i "s|@SERVICE_USER@|User=$SERVICE_USER|" "$out"
  else
    sed -i "/@SERVICE_USER@/d" "$out"
  fi
  grep -Eq "@(WORKTREE|DATA_DIR|ENV_FILE|SERVE_ARGS|WANTED_BY|SERVICE_USER)@" "$out" && { echo "rendered unit still contains a placeholder" >&2; return 1; }
  return 0
}

# Is a watchdog live right now (holds the flock)? Exit 0 = running.
# Without flock there is no guard to query, so report "not live": the
# watchdog itself runs unguarded then, and claiming a live watchdog
# would wrongly skip starting the unit after install (flock exits 127
# when missing, and `[ 127 -ne 0 ]` would read as "live").
watchdog_live() {
  [ -d "$DATA_DIR" ] || return 1
  [ -w "$DATA_DIR" ] || return 1
  command -v flock >/dev/null 2>&1 || return 1
  flock -n "$DATA_DIR/watchdog.lock" -c true 2>/dev/null
  [ $? -ne 0 ]
}

# systemd-analyze verify needs the .service suffix to recognise the file,
# so render into a temp DIRECTORY with the real unit name.
TMP_DIR="$(mktemp -d)"
TMP_UNIT="$TMP_DIR/$UNIT_NAME"
trap 'rm -rf "$TMP_DIR"' EXIT
render_unit "$TMP_UNIT" || exit 1

if [ "$DRY_RUN" = "1" ]; then
  echo "# dry run: nothing is installed. The unit would be written to:"
  echo "#   $UNIT_PATH"
  echo "# (scope $SCOPE, service user $SERVICE_USER, worktree $WORKTREE, data dir $DATA_DIR)"
  echo "# --- rendered unit ---"
  cat "$TMP_UNIT"
  echo "# --- commands the real run would execute ---"
  echo "# cp <unit> $UNIT_PATH   (existing unit backed up first)"
  [ "$SCOPE" = "user" ] && echo "# loginctl enable-linger $SERVICE_USER"
  echo "# $SYSTEMCTL daemon-reload"
  echo "# $SYSTEMCTL enable $UNIT_NAME"
  echo "# start only if no live server and no live watchdog (checked with --probe + flock)"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  bash -n "$WATCHDOG" || exit 1
  bash -n "${BASH_SOURCE[0]}" || exit 1
  command -v flock >/dev/null 2>&1 || echo "warning: flock not installed; the single-watchdog guard will be skipped at runtime." >&2
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$TMP_UNIT" || exit 1
    echo "systemd-analyze verify: OK"
  else
    echo "warning: systemd-analyze not available; unit syntax not verified." >&2
  fi
  echo "check: OK (unit renders cleanly for scope $SCOPE, service user $SERVICE_USER)"
  exit 0
fi

# --- real install ---
mkdir -p "$(dirname "$UNIT_PATH")"
if [ -f "$UNIT_PATH" ] && ! cmp -s "$TMP_UNIT" "$UNIT_PATH"; then
  BACKUP="$UNIT_PATH.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$UNIT_PATH" "$BACKUP"
  echo "existing unit backed up to $BACKUP"
fi
cp "$TMP_UNIT" "$UNIT_PATH"
chmod 644 "$UNIT_PATH"
echo "unit installed: $UNIT_PATH (scope $SCOPE, service user $SERVICE_USER)"

if [ "$SCOPE" = "user" ]; then
  if loginctl enable-linger "$SERVICE_USER" 2>/dev/null; then
    echo "linger enabled for $SERVICE_USER (user manager starts at boot, no login needed)"
  else
    echo "warning: 'loginctl enable-linger $SERVICE_USER' failed — without linger the user unit only starts after a login." >&2
    echo "Run as root: loginctl enable-linger $SERVICE_USER" >&2
  fi
fi

if ! $SYSTEMCTL daemon-reload 2>/dev/null; then
  echo "warning: '$SYSTEMCTL daemon-reload' failed (no $SCOPE manager in this session); the unit file is in place and loads at the next manager start." >&2
fi

if $SYSTEMCTL enable "$UNIT_NAME" 2>/dev/null; then
  echo "unit enabled"
else
  # systemctl enable needs a running manager; the enable itself is just a
  # symlink into <scope>.target.wants, so make it directly and say so.
  WANTS_DIR="$(dirname "$UNIT_PATH")/$WANTED_BY.wants"
  mkdir -p "$WANTS_DIR"
  ln -sf "$UNIT_PATH" "$WANTS_DIR/$UNIT_NAME"
  echo "systemctl enable failed (no $SCOPE manager in this session); enabled directly via $WANTS_DIR/$UNIT_NAME"
fi

# Secrets live in the env file, never in the unit. Tell the operator when
# it is missing instead of inventing values.
# %h in the unit is the SERVICE user's home, which is not $HOME when the
# installer runs as someone else (e.g. root installing for hatch).
case "$ENV_FILE" in
  %h/*) ENV_REAL="$SERVICE_HOME/${ENV_FILE#%h/}" ;;
  *) ENV_REAL="$ENV_FILE" ;;
esac
if [ ! -f "$ENV_REAL" ]; then
  echo "note: env file $ENV_REAL does not exist yet — create it mode 0600 with ORCHESTRA_PASSWORD (and ORCHESTRA_CONFIG_DIR / ORCHESTRA_SOCIETY_ROOT / ORCHESTRA_LOCAL if the live run uses them) before the next boot."
fi

# Start now ONLY when nothing is live. A running server or watchdog means
# the unit is already doing its job via the current process; starting the
# unit would stop that process's cgroup-mate (the server) on restart.
if HOLDER="$("$WATCHDOG" --data-dir "$DATA_DIR" --probe 2>/dev/null)"; then
  echo "server already running ($HOLDER); unit enabled for the next boot, NOT started now."
  exit 0
fi
if watchdog_live; then
  echo "watchdog already running; unit enabled for the next boot, NOT started now."
  exit 0
fi
if $SYSTEMCTL start "$UNIT_NAME" 2>/dev/null; then
  sleep 2
  echo "unit started: $($SYSTEMCTL is-active "$UNIT_NAME" 2>/dev/null || echo unknown)"
else
  echo "warning: '$SYSTEMCTL start $UNIT_NAME' failed in this session (no $SCOPE manager?); the unit is installed and enabled — start it with '$SYSTEMCTL start $UNIT_NAME' from a login session, or reboot." >&2
fi
echo "verify with: $SYSTEMCTL status $UNIT_NAME; tail the watchdog log at $DATA_DIR/watchdog.log"

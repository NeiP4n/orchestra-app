#!/bin/sh
# Сборка с нуля / репетиция сдачи (идея #16 из лучших 25 общего подхода).
#
# Перед сдачей проект собирается в чистом окружении: свежий worktree,
# установка зависимостей, сборка, проверки пакетов — без локальных путей,
# кэшей и недоговорённостей рабочего дерева. «У меня работает» не проходит.
#
# Что делает скрипт:
#   1. Создаёт свежий worktree во временной папке (по умолчанию из HEAD).
#   2. Устанавливает зависимости (bun install --frozen-lockfile).
#   3. Собирает серверный стек: schema, protocol, core, server, cli.
#   4. Прогоняет проверки: typecheck пакетов (script/check.ts) и lint.
#   5. По флагу --tests — тесты packages/core (область --test-scope).
#   6. Пишет квитанцию в worktree и, по флагу --record, запись в журнал
#      сдач (.orchestra/clean-build-log.md). Сдача без записи в журнале
#      о пройденном clean-build не считается сданной (см. docs/clean-build.md).
#
# Usage:
#   script/clean-build.sh [--ref <ref>] [--steps install,build,typecheck,lint,test]
#                         [--smoke] [--tests] [--test-scope <dir>] [--keep]
#                         [--record [journal-path]] [--dir <tmp-dir>]
#   script/clean-build.sh --smoke        # быстрая проверка: install + typecheck core
#
# Полный прогон typecheck всех пакетов требует памяти (на 8 ГБ может упасть
# по OOM — известное ограничение машины, а не скрипта); на маленькой машине
# используйте --smoke, а полный прогон — на машине с >= 16 ГБ.
set -eu

REF="HEAD"
STEPS="install,build,typecheck,lint"
SMOKE=0
KEEP=0
RECORD=""
DIR=""
TEST_SCOPE="test/autoloop"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    --tests) STEPS="$STEPS,test"; shift ;;
    --test-scope) TEST_SCOPE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --record)
      if [ "${2:-}" != "" ] && [ "${2#-}" = "$2" ]; then RECORD="$2"; shift 2; else RECORD=".orchestra/clean-build-log.md"; shift; fi ;;
    --dir) DIR="$2"; shift 2 ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "clean-build: неизвестный флаг $1" >&2; exit 2 ;;
  esac
done

if [ "$SMOKE" = 1 ]; then STEPS="install,typecheck"; fi

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
if [ -z "$DIR" ]; then DIR="$(mktemp -d /tmp/clean-build-XXXXXXXX)"; rmdir "$DIR"; fi
STARTED="$(date -u +%s)"
STATUS="FAIL"
COMMIT=""

log() { printf '[clean-build %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    log "worktree сохранён: $DIR"
    return
  fi
  if [ -d "$DIR" ]; then
    cd "$REPO" 2>/dev/null || true
    git worktree remove --force "$DIR" 2>/dev/null || rm -rf "$DIR"
    git worktree prune 2>/dev/null || true
  fi
}
trap cleanup EXIT

log "ref: $REF, шаги: $STEPS, worktree: $DIR"
if ! git worktree add --detach "$DIR" "$REF" 2>/dev/null; then
  log "worktree не создан, пробую git clone --local"
  git clone --local --no-hardlinks "$REPO" "$DIR"
fi
COMMIT="$(git -C "$DIR" rev-parse --short HEAD)"
cd "$DIR"

step() {
  name="$1"; shift
  log "шаг $name: $*"
  start="$(date -u +%s)"
  if ! "$@"; then
    log "шаг $name ПРОВАЛЕН"
    return 1
  fi
  log "шаг $name пройден за $(( $(date -u +%s) - start ))с"
}

case ",$STEPS," in
  *,install,*) step install bun install --frozen-lockfile ;;
esac
case ",$STEPS," in
  *,build,*)
    for pkg in schema protocol core server cli; do
      step "build:$pkg" bun run --cwd "packages/$pkg" build
    done ;;
esac
case ",$STEPS," in
  *,typecheck,*)
    if [ "$SMOKE" = 1 ]; then step typecheck bun script/check.ts core;
    else step typecheck bun script/check.ts --all; fi ;;
esac
case ",$STEPS," in
  *,lint,*) step lint bun run lint ;;
esac
case ",$STEPS," in
  *,test,*) step test bun --cwd packages/core test "$TEST_SCOPE" ;;
esac

STATUS="PASS"
ENDED="$(date -u +%s)"
DURATION="$((ENDED - STARTED))"
log "ЧИСТАЯ СБОРКА ПРОЙДЕНА за ${DURATION}с (ref $REF, commit $COMMIT)"

RECEIPT="$DIR/clean-build-receipt.md"
{
  echo "# Clean-build receipt"
  echo ""
  echo "- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- ref: $REF"
  echo "- commit: $COMMIT"
  echo "- steps: $STEPS"
  echo "- duration_s: $DURATION"
  echo "- result: $STATUS"
} > "$RECEIPT"
log "квитанция: $RECEIPT"

if [ -n "$RECORD" ]; then
  JOURNAL="$REPO/$RECORD"
  mkdir -p "$(dirname "$JOURNAL")"
  if [ ! -f "$JOURNAL" ]; then
    printf '# Журнал чистых сборок\n\nКаждая сдача требует записи о пройденном clean-build (см. docs/clean-build.md).\n\n' > "$JOURNAL"
  fi
  {
    echo "## $(date -u +%Y-%m-%dT%H:%M:%SZ) — $REF ($COMMIT) — $STATUS"
    echo ""
    sed 's/^# Clean-build receipt/- квитанция:/; s/^- /  - /' "$RECEIPT"
    echo ""
  } >> "$JOURNAL"
  log "запись в журнале: $JOURNAL"
fi

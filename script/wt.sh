#!/usr/bin/env bash
# Помощник для работы с worktree — единый стандарт Orchestra.
#
# Поверх `wt` (worktrunk, https://worktrunk.dev), с fallback на чистый
# `git worktree`, когда `wt` не установлен. Правила — из docs/worktree-standard.md:
#   - ветка: короткое имя, 1–3 слова через дефис, без слешей и префиксов типа feat/;
#   - база: всегда main; мёрж — только координатором, локально, без пуша в remote;
#   - worktree: ~/workspace/orchestra-app-<ветка>;
#   - в новом worktree зависимости ставятся по-настоящему (bun install),
#     а не симлинками node_modules на старый checkout.
#
# Использование (из любого места внутри репозитория):
#   script/wt.sh new <ветка>        создать ветку + worktree от main и прогнать setup
#   script/wt.sh setup [путь]       убрать симлинки node_modules, bun install, проверить резолв
#   script/wt.sh check [путь]       проверить worktree перед мёржем (чистота, имя, симлинки)
#   script/wt.sh merge <ветка>      слить ветку в main merge-коммитом, убрать worktree и ветку
#   script/wt.sh remove <ветка>     убрать worktree и ветку (отказ, если не слита)
#   script/wt.sh list               список worktree
#   script/wt.sh path <ветка>       путь worktree по стандарту
#   script/wt.sh validate-name <ветка>
#
# Переменные окружения:
#   WT_BASE          базовая ветка (по умолчанию main)
#   WT_NO_WORKTRUNK  =1 — не использовать `wt`, только git
set -euo pipefail

BASE="${WT_BASE:-main}"

die() { echo "wt.sh: $*" >&2; exit 1; }

# Корень репозитория, в котором запустили скрипт (worktree, в котором мы стоим).
repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "не внутри git-репозитория"
}

# Есть ли установленный worktrunk (и не отключён ли он явно).
has_wt() {
  [ "${WT_NO_WORKTRUNK:-0}" != "1" ] && command -v wt >/dev/null 2>&1
}

# Имя ветки по стандарту: 1–3 слова из строчных букв и цифр, через дефис.
# Без слешей, без префиксов типа feat/, без подчёркиваний и заглавных.
# `main` — база, она допустима везде, где проверяется текущий checkout.
validate_name() {
  local branch="$1"
  if [ "$branch" = "$BASE" ]; then
    return 0
  fi
  if [[ ! "$branch" =~ ^[a-z0-9]+(-[a-z0-9]+){0,2}$ ]]; then
    echo "wt.sh: неверное имя ветки '$branch': нужно 1–3 слова через дефис, только строчные буквы и цифры, без слешей и префиксов (например: news-worktrunk)" >&2
    return 1
  fi
  if [ "${#branch}" -gt 40 ]; then
    echo "wt.sh: имя ветки '$branch' длиннее 40 символов" >&2
    return 1
  fi
}

# Стандартный путь worktree: <родитель репозитория>/orchestra-app-<ветка>.
worktree_path() {
  local branch="$1"
  local root
  root="$(repo_root)"
  echo "$(dirname "$root")/orchestra-app-$branch"
}

# Симлинки node_modules внутри worktree (в корне и в packages/*) — признак
# того, что зависимости не ставились, а tests гоняют чужой старый код.
node_modules_symlinks() {
  local path="$1"
  find "$path" -name node_modules -type l -not -path "*/node_modules/*" 2>/dev/null
}

cmd_validate_name() {
  validate_name "${1:-}" || exit 1
}

cmd_path() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "укажите имя ветки: wt.sh path <ветка>"
  validate_name "$branch" || exit 1
  worktree_path "$branch"
}

# Привести worktree в рабочее состояние: убрать симлинки node_modules,
# поставить зависимости, проверить, что пакеты резолвятся внутрь worktree.
cmd_setup() {
  local path="${1:-$(repo_root)}"
  [ -d "$path" ] || die "нет такого каталога: $path"
  local bad
  bad="$(node_modules_symlinks "$path")"
  if [ -n "$bad" ]; then
    echo "wt.sh: убираю симлинки node_modules:"
    echo "$bad"
    echo "$bad" | xargs rm
  fi
  if [ -f "$path/package.json" ]; then
    if [ ! -d "$path/node_modules" ]; then
      echo "wt.sh: bun install в $path"
      (cd "$path" && bun install)
    fi
    # Проверка из AGENTS.md: резолв пакета должен указывать внутрь worktree,
    # а не в чужой checkout.
    if [ -f "$path/packages/core/src/dod-kanban.ts" ]; then
      local resolved
      resolved="$(cd "$path/packages/cli" && bun -e "console.log(require.resolve('@orchestra/core/dod-kanban'))" 2>/dev/null || true)"
      case "$resolved" in
        "$path"/*) echo "wt.sh: пакеты резолвятся внутрь worktree: $resolved" ;;
        *) die "пакеты резолвятся НЕ внутрь worktree: '${resolved:-пусто}' — зависимости поставлены неверно" ;;
      esac
    fi
  fi
  echo "wt.sh: setup готов: $path"
}

# Проверка worktree перед мёржем: чистое дерево, допустимое имя ветки,
# нет симлинков node_modules.
cmd_check() {
  local path="${1:-$(repo_root)}"
  [ -d "$path/.git" ] || [ -f "$path/.git" ] || die "не worktree: $path"
  local branch
  branch="$(git -C "$path" branch --show-current)"
  [ -n "$branch" ] || die "в $path detached HEAD — check требует ветки"
  validate_name "$branch" || exit 1
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    echo "wt.sh: в $path есть незакоммиченные изменения:" >&2
    git -C "$path" status --porcelain >&2
    exit 1
  fi
  local bad
  bad="$(node_modules_symlinks "$path")"
  if [ -n "$bad" ]; then
    echo "wt.sh: в $path симлинки node_modules (зависимости не ставились):" >&2
    echo "$bad" >&2
    exit 1
  fi
  local base_sha
  base_sha="$(git -C "$path" rev-parse --verify "$BASE" 2>/dev/null || true)"
  [ -n "$base_sha" ] || die "нет базовой ветки $BASE"
  echo "wt.sh: check OK: ветка $branch, дерево чистое, база $BASE ($base_sha)"
}

cmd_new() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "укажите имя ветки: wt.sh new <ветка>"
  validate_name "$branch" || exit 1
  local root
  root="$(repo_root)"
  git -C "$root" rev-parse --verify "$BASE" >/dev/null 2>&1 || die "нет базовой ветки $BASE"
  git -C "$root" show-ref --verify --quiet "refs/heads/$branch" && die "ветка $branch уже существует"
  local path
  path="$(worktree_path "$branch")"
  [ -e "$path" ] && die "путь уже существует: $path"
  local base_sha
  base_sha="$(git -C "$root" rev-parse --short "$BASE")"
  echo "wt.sh: создаю ветку $branch от $BASE ($base_sha) в $path"
  if has_wt; then
    (cd "$root" && wt -y switch -c "$branch" -b "$BASE" --no-cd --path "$path")
  else
    git -C "$root" worktree add "$path" -b "$branch" "$BASE"
  fi
  cmd_setup "$path"
  echo "wt.sh: готово. Перейти: cd $path"
}

cmd_merge() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "укажите имя ветки: wt.sh merge <ветка>"
  validate_name "$branch" || exit 1
  [ "$branch" != "$BASE" ] || die "нельзя слить $BASE в саму себя"
  local root
  root="$(repo_root)"
  local current
  current="$(git -C "$root" branch --show-current)"
  [ "$current" = "$BASE" ] || die "мёрж делается из worktree базы $BASE, а вы в '$current'"
  git -C "$root" show-ref --verify --quiet "refs/heads/$branch" || die "нет ветки $branch"
  local path
  path="$(git -C "$root" worktree list --porcelain | awk -v b="refs/heads/$branch" '$1 == "worktree" { w = $2 } $1 == "branch" && $2 == b { print w }')"
  [ -n "$path" ] || die "у ветки $branch нет worktree"
  cmd_check "$path"
  echo "wt.sh: сливаю $branch в $BASE merge-коммитом (без squash, без rebase, без fast-forward)"
  if has_wt; then
    (cd "$root" && wt -y merge "$BASE" -b "$branch" --no-squash --no-rebase --no-ff)
  else
    git -C "$root" merge --no-ff -m "Merge branch '$branch' into $BASE" "$branch"
    git -C "$root" worktree remove "$path"
    git -C "$root" branch -d "$branch"
  fi
  echo "wt.sh: слито: $branch → $BASE"
}

cmd_remove() {
  local branch="${1:-}"
  local force="${2:-}"
  [ -n "$branch" ] || die "укажите имя ветки: wt.sh remove <ветка>"
  validate_name "$branch" || exit 1
  [ "$branch" != "$BASE" ] || die "базовую ветку $BASE удалять нельзя"
  local root
  root="$(repo_root)"
  git -C "$root" show-ref --verify --quiet "refs/heads/$branch" || die "нет ветки $branch"
  if has_wt; then
    if [ "$force" = "--force" ]; then
      (cd "$root" && wt -y remove -f -D "$branch")
    else
      (cd "$root" && wt -y remove "$branch")
    fi
  else
    local path
    path="$(git -C "$root" worktree list --porcelain | awk -v b="refs/heads/$branch" '$1 == "worktree" { w = $2 } $1 == "branch" && $2 == b { print w }')"
    if [ -n "$path" ]; then
      if [ "$force" = "--force" ]; then
        git -C "$root" worktree remove --force "$path"
      else
        git -C "$root" worktree remove "$path"
      fi
    fi
    if [ "$force" = "--force" ]; then
      git -C "$root" branch -D "$branch"
    else
      git -C "$root" branch -d "$branch"
    fi
  fi
  echo "wt.sh: убрано: $branch"
}

cmd_list() {
  local root
  root="$(repo_root)"
  if has_wt; then
    (cd "$root" && wt list)
  else
    git -C "$root" worktree list
  fi
}

usage() {
  sed -n '2,24p' "$0" | sed 's/^# //;s/^#$//'
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    new) shift; cmd_new "$@" ;;
    setup) shift; cmd_setup "$@" ;;
    check) shift; cmd_check "$@" ;;
    check-merge)
      # Для pre-merge хука worktrunk: проверить worktree сливаемой ветки.
      shift; cmd_check "$(worktree_path "${1:-}")" ;;
    merge) shift; cmd_merge "$@" ;;
    remove) shift; cmd_remove "$@" ;;
    list) shift; cmd_list "$@" ;;
    path) shift; cmd_path "$@" ;;
    validate-name) shift; cmd_validate_name "$@" ;;
    *) usage; exit "${2:-1}" ;;
  esac
}

main "$@"

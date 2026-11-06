# Стандарт работы с worktree (координаторы и исполнители)

Один агент = один worktree = одна ветка. Источник: новость run5, БРАТЬ №3 —
[max-sixty/worktrunk](https://github.com/max-sixty/worktrunk) (Rust CLI,
MIT/Apache-2.0, v0.81.0). Мы уже работали через worktree вручную; этот документ
делает работу единой: один инструмент (`wt`), один helper (`script/wt.sh`),
одна раскладка каталогов, одни правила мёржа.

## Раскладка

- `main` живёт в worktree `~/workspace/orchestra-app-security` (ветка `main`,
  на момент написания — `feb3c4f`). Это «главный» checkout.
- Каждый исполнитель — в своём worktree: `~/workspace/orchestra-app-<ветка>`.
  Например, ветка `news-worktrunk` → `~/workspace/orchestra-app-news-worktrunk`.
- НЕ трогать checkout `~/workspace/orchestra-app` — там старая ветка
  `fix/projects-chat`, это не main и не база для новых работ.

## Установка worktrunk

`wt` — один бинарник, Rust не нужен. Проверено в этой VM (v0.81.0):

```sh
cd /tmp && curl -sL -o worktrunk.tar.xz \
  https://github.com/max-sixty/worktrunk/releases/download/v0.81.0/worktrunk-x86_64-unknown-linux-musl.tar.xz
# сверить sha256 с файлом worktrunk-x86_64-unknown-linux-musl.tar.xz.sha256 из того же релиза
tar -xf worktrunk.tar.xz
cp worktrunk-x86_64-unknown-linux-musl/wt ~/.local/bin/ && chmod +x ~/.local/bin/wt
wt --version   # wt v0.81.0
```

`~/.local/bin` по умолчанию НЕ в `PATH` этой VM — перед работой с `wt`
добавить его: `export PATH="$HOME/.local/bin:$PATH"` (или прописать в профиль
shell). Без `wt` в `PATH` `script/wt.sh` молча переходит на чистый `git`
и стандарт всё равно держится, но `wt list` / `wt merge` напрямую
не сработают.

Без `wt` тот же стандарт выполняет `script/wt.sh` на чистом `git worktree`
(fallback автоматический; принудительно — `WT_NO_WORKTRUNK=1`).

## Имена веток

Короткое имя, 1–3 слова через дефис, только строчные буквы и цифры.
Без слешей, без префиксов типа `feat/` или `fix/`, не длиннее 40 символов.
Это правило уже есть в `AGENTS.md` («Branch Names»); `script/wt.sh` его проверяет.

Хорошо: `news-worktrunk`, `b16-gaps`, `fix-scroll-state`.
Плохо: `fix/b10-catalog-2026-11-06`, `news/worktrunk`, `Fix_Scroll`.

## Создание worktree

```sh
cd ~/workspace/orchestra-app-security   # из worktree main
script/wt.sh new <ветка>                # ветка от main + worktree + setup
cd ~/workspace/orchestra-app-<ветка>
```

Эквивалент напрямую через `wt` (когда `script/wt.sh` недоступен):

```sh
wt -y switch -c <ветка> -b main --no-cd --path ~/workspace/orchestra-app-<ветка>
```

Что делает `setup` (он же хук `pre-start` в `.config/wt.toml`):

1. Удаляет симлинки `node_modules` — в новом worktree их быть не должно.
   Симлинк на чужой checkout — известная ловушка (см. `AGENTS.md`, уроки 2026-11-06):
   тесты тогда гоняют чужой старый код.
2. `bun install` (если `node_modules` нет).
3. Проверяет, что `require.resolve('@orchestra/core/dod-kanban')` указывает
   внутрь этого worktree.

Флаг `--no-cd` обязателен: shell-интеграция `wt` в этой VM не ставится
(`wt config shell install` нечего настраивать — нет `~/.bashrc`/`~/.zshrc`),
переход делается обычным `cd`.

## Работа в worktree

- Перед изменением системы — прочитать её раздел в `AI_ATLAS.md` и обновить
  этот раздел в том же изменении.
- Проверки — из своего worktree: `bun run check` из корня (если трогал код),
  `bun test` в затронутом пакете, тест helper-скрипта, если он есть.
- Живой сервер (порт 17890) не перезапускать.
- Коммиты — в свою ветку, conventional commits (`feat:`, `fix:`, `docs:`, …).

## Мёрж — только координатор

Исполнитель НЕ мержит сам. Координатор, из worktree main:

```sh
cd ~/workspace/orchestra-app-security
script/wt.sh merge <ветка>
```

Что происходит:

1. `script/wt.sh check` в worktree ветки: дерево чистое (всё закоммичено),
   имя ветки допустимое, нет симлинков `node_modules`.
2. Полные проверки ветки — отдельно, по `docs/integration-window.md`
   (интеграционное окно в scratch-worktree, по пакетам последовательно).
3. Мёрж merge-коммитом в `main`: без squash, без rebase, без fast-forward —
   история ветки сохраняется, как во всех мёржах `main` (например, `feb3c4f`).
4. Worktree и ветка удаляются после мёржа.

Напрямую через `wt`:

```sh
wt -y merge main -b <ветка> --no-squash --no-rebase --no-ff
```

## Удаление worktree

```sh
script/wt.sh remove <ветка>            # только если ветка уже слита в main
script/wt.sh remove <ветка> --force    # убрать неслитую ветку (осознанно)
```

`script/wt.sh list` — список worktree (или `wt list`).

## Настройки worktrunk

Проектный конфиг `.config/wt.toml` (в репозитории) задаёт то, что worktrunk
разрешает хранить в проекте: хуки `pre-start` / `pre-merge` и стиль сообщений
коммитов. Проверено на wt v0.81.0: `worktree-path`, `[merge]` и `[remove]`
в проектном файле ИГНОРИРУЮТСЯ — они живут только в пользовательском конфиге.
Кто работает голым `wt`, добавляет в `~/.config/worktrunk/config.toml`:

```toml
[projects."github.com/NeiP4n/orchestra-app"]
worktree-path = "{{ repo_path }}/../orchestra-app-{{ branch | sanitize }}"
merge.squash = false
merge.rebase = false
merge.ff = false
merge.remove = true
remove.delete-branch = true
```

`script/wt.sh` передаёт флаги мёржа явно, поэтому стандарт держится и без
этого конфига. Первый запуск хука из `.config/wt.toml` `wt` попросит
подтвердить один раз; для автоматики — `wt -y ...`.

## Запреты

- Никакого пуша в remote GitHub в любом виде; никакого force-push.
- Не удалять ветки вручную (`git branch -D`) — только `remove` после мёржа.
- Не создавать ветки с `/` и не мержить из ветки, чья база не `main`.
- Не работать в `~/workspace/orchestra-app` (старый checkout).
- Не менять пароли и ключи, не записывать ключи в файлы, память и чат.

## Замечания по хукам

- Хуки (`pre-start`, `pre-merge`) запускают `script/wt.sh` из файлов
  репозитория. Поэтому они работают только после того, как ветка с helper-скриптом
  закоммичена: worktree, созданный из незакоммиченной ветки, не содержит
  `script/wt.sh`, и `pre-start` падает с `not found` (exit 127).
- Если `pre-start` упал, `wt` НЕ убирает созданный worktree и ветку —
  их надо убрать вручную (`wt -y remove -f -D <ветка>`) и повторить создание
  после коммита helper-скрипта. Обойти хук разово: `wt switch -c ... --no-hooks`.

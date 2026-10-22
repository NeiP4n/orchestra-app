# Orchestra: установка и запуск

## Установка (одна команда)
Windows (PowerShell), из папки проекта:
```
.\installer\install.ps1
```
Скрипт копирует `orchestra.exe` в `%LOCALAPPDATA%\Programs\orchestra` и добавляет эту папку в PATH пользователя. Права администратора не нужны. Откройте **новый** терминал и пишите `orchestra`.

Варианты: `-Url <ссылка>` (скачать готовый бинарь), `-Source <путь>`, `-Uninstall` (удалить программу и запись в PATH; сессии и память остаются).
Linux / macOS / Git Bash: `sh installer/install.sh` (нужен Rust или готовый бинарь `sh installer/install.sh <путь>`).

## Первый запуск
```
orchestra setup      # подключить модель: адрес, ключ, имя модели (можно запасной адрес)
orchestra            # работать
```
Без `setup` Orchestra запускается в режиме «вы отвечаете за модель»: обычный текст — ответ, `/call имя {json}` — вызов инструмента. Так можно проверить сессии, память и инструменты без ключа и сети.

Подходит любой сервер с OpenAI-совместимым API: ваш ключ у сервиса, локальная модель, шлюз. Настройка хранится в `config.json` (там же, где данные). Переменные окружения `ORCHESTRA_BASE_URL`, `ORCHESTRA_API_KEY`, `ORCHESTRA_MODEL` (списки через запятую = пул с автопереключением) перекрывают файл на один запуск. Ключ лежит в файле открытым текстом в вашем профиле пользователя.

## В приглашении
`/new`, `/sessions`, `/memory`, `/remember <ключ> <текст>`, `/forget <ключ>`, `/quit`. Ctrl+C прерывает текущий ход.
Параметры: `--session <id>`, `--list`, `--human`, `--help`.

## Где что лежит
`%USERPROFILE%\.local\share\orchestra` (или `ORCHESTRA_HOME`): `config.json`, `sessions\*.jsonl`, `memory\*.jsonl` (global, project-*, session-*).

## Сборка из исходников
Нужны Rust (GNU-цепочка) и mingw-w64 в PATH: `cargo build --release -p orchestra`. Тесты: `cargo test --workspace`.

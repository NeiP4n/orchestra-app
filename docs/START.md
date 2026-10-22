# Запуск Orchestra

Бинарь: `dist\orchestra.exe` (6,7 МБ, без установки, зависит только от системных DLL Windows).

## Без ключа и без сети (режим «человек отвечает»)
```
dist\orchestra.exe --human
```
Вы пишете запрос, затем сами отвечаете за «модель»: обычный текст — ответ, `/call имя_инструмента {json}` — вызов инструмента. Так можно проверить весь стек: сессии, память, инструменты.

## С моделью (любой сервер с OpenAI-совместимым API: ваш ключ, локальный сервер, шлюз)
```
set ORCHESTRA_BASE_URL=https://api.openai.com/v1
set ORCHESTRA_API_KEY=ваш_ключ
set ORCHESTRA_MODEL=gpt-4o-mini
dist\orchestra.exe
```
Несколько источников через запятую образуют пул с автопереключением при лимитах:
`ORCHESTRA_BASE_URL=url1,url2`, `ORCHESTRA_API_KEY=key1,key2`, `ORCHESTRA_MODEL=m1,m2`.

## Команды в приглашении
`/new`, `/sessions`, `/memory`, `/remember <ключ> <текст>`, `/forget <ключ>`, `/quit`. Ctrl+C прерывает текущий ход.
Параметры: `--session <id>` (продолжить сессию), `--list`, `--help`.

## Где хранится
`%USERPROFILE%\.local\share\orchestra` (или `ORCHESTRA_HOME`): `sessions\*.jsonl` — журнал сессий, `memory\*.jsonl` — память (global, project-*, session-*).

## Сборка из исходников
Нужны Rust (GNU-цепочка) и mingw-w64 в PATH: `cargo build --release -p orchestra`. Тесты: `cargo test --workspace`.

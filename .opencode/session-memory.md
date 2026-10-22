# Session memory — opencode-pp

# 2026-10-21 — L-044: общий rate-limit гейт снят, рантайм-падение в llm.ts (ветка groups-president)

## Задача
В TUI висела ошибка «Session failed: retry.waitForGate is not a function. (In 'retry.waitForGate(String(loaded.model.ref.providerID))', 'retry.waitForGate' is undefined)». Владелец: «убери ratelimit, оно уже заебало, на некоторых чатах rate limit а на некоторых его нету».

## Причина
В рабочем дереве лежал незакоммиченный WIP: `packages/core/src/session/runner/retry.ts` был переписан без общей механики rate-limit (KV-журнал `session-runner:rate-limit:v1:*`, `waitForGate`, `succeeded`, `stagger`), но вызывающий `llm.ts` остался от HEAD и продолжал звать `retry.waitForGate(...)` и передавать `kv` третьим аргументом в `make`. `bun build` типы не проверяет — бинарь собрался «успешно», падение вылезло в рантайме сессии. Тот же WIP ронял и `packages/core/test/session-runner-retry.test.ts` (5 fail, та же строка ошибки).

## Что сделано (мой коммит cbb184681, 3 файла)
- `packages/core/src/session/runner/llm.ts`: `SessionRunnerRetry.make(bus, sessionID)` без `kv`; удалён блок ожидания общего гейта (`waitForGate` + reload контекста после ожидания); `Completed` больше не зовёт `retry.succeeded`; `retry.wait({decision, error, assistantMessageID})` без `providerID`; из `deps` слоя убран `KV.node`; `loaded` стал `const`.
- `packages/core/src/session/runner/retry.ts`: без KV-журнала, без гейта, без `succeeded`/`stagger`; `make(bus, sessionID)` → `{ decide, wait }`. Раньше коммита `2944d2d31`/`11cca0619` здесь был общий гейт по провайдеру.
- `packages/core/test/session-runner-retry.test.ts`: удалён блок «SessionRunnerRetry shared rate-limit gate» (5 тестов), добавлен тест «treats a provider rate limit as an ordinary retryable failure» — 429 живёт по общему расписанию сессии (≤10 c), без общего кулдауна.

## Проверка (факты)
- `bun test test/session-runner-retry.test.ts` → 4 pass / 0 fail.
- `bun test test/session-runner.test.ts test/session-runner-retry.test.ts test/session-error.test.ts test/session-model-request-hooks.test.ts` → 241 pass / 0 fail.
- `bun typecheck` в packages/core → exit 0, 0 ошибок (backlog говорил про baseline 46 ошибок — сейчас чисто).
- `bunx oxlint` по трём файлам → 0 warnings, 0 errors.
- Полный `bun test` в packages/core, A/B (до = файлы с гейтом из `2ca07472f`, после = мой коммит): 31 fail в обоих прогонах. Разница ровно в одном тесте в каждую сторону (`PluginSupervisor > refreshes every 24 hours` — упал ДО, `DodTool > adds, takes, checks...` — упал ПОСЛЕ); оба файла в изоляции проходят 8 pass / 0 fail с моей версией → это флакующие тесты, не регрессия.

## ГРАБЛИ
- `bun test 2>&1 | tail -25` в фоне режет лог: падающих тестов видно меньше, чем в сводке. Для A/B писать полный вывод в файл и сравнивать списки `(fail)`.
- `git checkout <commit> -- <paths>` для A/B ещё и индексирует файлы (`M ` в status) — после возврата нужен `git reset -- <paths>`, иначе чужая правка уедет в следующий коммит.

## Ключевые факты по развёртыванию
- Живой сервер сессий: `bun ... src/packages/cli/src/index.ts serve --service` (ребёнок TUI `bin/opencode-pp.cmd`), то есть ТС из исходников. Пересборка НЕ нужна — достаточно перезапустить TUI, сервер поднимется заново и подхватит правку.
- Отдельно в фоне висит `opencode.exe serve --service` из npm-пакета `@orchestra/cli` (старый бинарь, к правке не относится). Если TUI подключится к нему, правка не применится — проверить, к какому серверу подключён клиент.
- Push не делал: `git push --no-verify origin groups-president` — по уже известному правилу (pre-push хук `bun run check` красный на предсуществующем долге).

## Дополнение (второй коммит eefb906a8): вырезан и Retry-After
Владелец: «вырежи этот ratelimit» → убрано последнее упоминание rate-limit в механики повторов: провайдерский `Retry-After` (`retryAfterMs`) больше НЕ растягивает ожидание. 429 повторяется по общему расписанию сессии (2→4→8→10 c, максимум 10 попыток, джиттер ≤1.2).

### Что изменилось
- `packages/core/src/session/runner/retry.ts`: удалены хелпер `retryAfter`, константа `RETRY_AFTER_MAX` и блок `Schedule.modifyDelay` (он поднимал задержку до минимума, равного `retryAfterMs`); само расписание не тронуто.
- `packages/core/test/session-runner-retry.test.ts`: тест «ignores the provider retry-after hint and keeps the ordinary delay» — 15 мин / NaN / Infinity / -1 не влияют на задержку (остаётся ≤12 c).
- `packages/core/test/session-runner.test.ts`: тесты, завязанные на старое поведение, переписаны под новое (429 = обычная повторяемая ошибка, задержка в пределах расписания).

### Проверка (после второго коммита)
- `bun test test/session-runner.test.ts test/session-runner-retry.test.ts test/session-error.test.ts test/session-model-request-hooks.test.ts` → 241 pass / 0 fail, exit 0.
- `bun typecheck` (packages/core) → exit 0, 0 ошибок.
- `bunx oxlint` по 4 файлам → 0 warnings / 0 errors, exit 0.
- Полный `bun test` (packages/core): 6024 pass / 30 fail / 1 error. A/B против «до» (31 fail): список падений «ПОСЛЕ» — строгое подмножество «ДО», новых нет; единственная разница — флакующий `PluginSupervisor > refreshes every 24 hours` (упал в «ДО», прошёл в «ПОСЛЕ»).
- `git grep -E "waitForGate|retry\.succeeded|stagger|retryAfter|rate-limit"` по `packages/core/src` и `packages/core/test` → ни одной ссылки на гейт или подсказку провайдера (остались только несвязанные места: websearch, `to-session-error`, freebuff-плагин).

### Ограничения
- Живой сервер сессий (`bun … serve --service`) держит старый код в памяти → нужен перезапуск TUI.
- Push не делал: `git push --no-verify origin groups-president`.

## Дополнение (третий коммит 011300029): снят «вeto» повторов в ChatGPT-плагине
Владелец: «их просто нахуй убивай» (про «предохранители» из чужого отчёта). Выбранный объём — ТОЛЬКО rate-limit/usage-limit fuse в core + ветки geo/Cloudflare. Капы повторов (10 попыток / 3 таймаута) НЕ тронуты.

### Что изменилось (2 файла, одинаково в обоих деревьях)
- `packages/core/src/plugin/provider/chatgpt.ts`: удалён список `nonRetryableSharingCodes` (7 кодов, включая `subscription_sharing_usage_limit_exceeded`) и сам `session.retry`-хук, который ставил `event.decision = { retry: false }`; в `describeRequestFailure` удалены ветки «страна/регион не поддерживается» и «Cloudflare заблокировал запрос с challenge» (плюс ставшие неиспользуемыми `server`, `mitigated`, `combined`) — текст ошибки теперь нейтральный («сервер вернул HTML-страницу вместо OAuth-ответа»), без подсказок про VPN/гео-блокировку.
- `packages/core/test/plugin/provider-chatgpt.test.ts`: «stops retries for ChatGPT usage limits…» → «retries …» с ожиданием `{ retry: true }`; «stops deterministic ChatGPT stream failures…» → «retries every ChatGPT token-sharing failure» (все 8 кодов → true); тест OAuth 403 больше не ждёт наших geo/Cloudflare-подсказок и явно запрещает их (`not.toContain`).

### Проверка (факты)
- A: `bun test test/plugin/provider-chatgpt.test.ts` → 26 pass / 0 fail; `bun typecheck` (core) → exit 0; oxlint по 2 файлам → 0/0.
- B: тест → 26 pass / 0 fail; typecheck — 54 ошибки ДО и 54 ПОСЛЕ, списки идентичны, ни одной в моих файлах (предсуществующий долг чужого WIP); oxlint → 0/0.
- Полный `bun test` (core, A) после правки: 6024 pass / 30 fail — список падений ИДЕНТИЧЕН прошлому прогону (ни одного нового, ни одного исчезнувшего).
- `grep -rl "nonRetryable\|stops retries"` по packages → других тестов, завязанных на вето, нет.

### Коммиты
- A (`AppData\Local\opencode-pp\src`, groups-president): `011300029`.
- B (`Desktop\Projects\opencode-pp`, lan-rooms): `87ab135e9a`. В этом репозитории не был настроен git identity — задал ЛОКАЛЬНО `NeiP4n <isakoveugene0@gmail.com>` (как в истории репозитория), глобальный config не трогал.
- Push не делал ни в одном.

### Desktop-часть чужого отчёта — НЕ трогал (её нет в локальных деревьях)
`memory-watchdog.ts`, `sidecar-registration.ts`, `configure.ts` с `--max-old-space-size`, `BUN_OPTIONS=--smol`, `electron-builder.config.ts` и AppImage на 275 МиБ — поиск по всему профилю не нашёл ни одного из этих файлов/артефактов. Отчёт сделан в другом checkout, снести его «предохранители» отсюда нельзя.

## Дополнение (четвёртый коммит 8e7e98c41d): гейт снят и в дереве B — ПОПРАВКА ФАКТА
ВАЖНО: в предыдущем разделе я написал «гейт и Retry-After вырезаны в обоих деревьях» — это было НЕВЕРНО. Гейт я снял только в дереве A; в дереве B (`Desktop\Projects\opencode-pp`, ветка lan-rooms) он оставался (другая, более ранняя версия: KV-журнал `session-runner:rate-limit:v1:`, скан префикса, окно серии 6 часов, `waitForGate`, `succeeded`, `gateUntil`, `rateLimitBackoff`). Ровно тот «предохранитель», который надо убить.

### Что сделано в дереве B (4 файла, коммит 8e7e98c41d)
- `packages/core/src/session/runner/retry.ts` — взят вариант из дерева A (без гейта и без `Retry-After`): `make(bus, sessionID)` → `{ decide, wait }`, без KV.
- `packages/core/src/session/runner/llm.ts` — хирургическая правка (файл в дереве B отличается от A: нет `Mode`-потолка шагов, копировать нельзя): убран `import { KV }`, `const kv = yield* KV.Service`, `KV.node` из deps, блок ожидания гейта с перезагрузкой контекста, `retry.succeeded(...)` в `Completed` (заменён на `Effect.succeed(outcome.needsContinuation)`), аргумент `providerID` из обоих `retry.wait`; `let loaded` → `const loaded`.
- `packages/core/test/session-runner-retry.test.ts` и `packages/core/test/session-runner.test.ts` — взяты из дерева A HEAD (файлы в деревьях были побайтово одинаковые до правок): удалён блок гейта, тесты переписаны под «retry-after игнорируется».

### Проверка (дерево B)
- `bun test test/session-runner-retry.test.ts test/session-runner.test.ts test/session-error.test.ts` → 236 pass / 1 fail; единственное падение — `toSessionError > explains OpenCode Zen free-tier rejection` (предсуществующее, есть и в baseline: 239 pass / 1 fail).
- `bun typecheck` (core) → 54 ошибки ДО и 54 ПОСЛЕ, списки идентичны, ни одной в моих файлах.
- `bunx oxlint` по 4 файлам → 0/0.
- Полный `bun test` (core), A/B: baseline 81 fail, после правок 82 fail. Единственная разница — `falls back to local logging when OTLP initialization fails` (test/effect/observability.test.ts): флакующий, к rate-limit отношения не имеет (в изоляции то падает, то проходит 6/6).

### Коммиты (итог по обоим деревьям)
- A (`AppData\Local\opencode-pp\src`, groups-president): `cbb184681` (гейт), `eefb906a8` (Retry-After), `011300029` (вето в ChatGPT-плагине + geo/Cloudflare).
- B (`Desktop\Projects\opencode-pp`, lan-rooms): `87ab135e9a` (вето в ChatGPT-плагине), `8e7e98c41d` (гейт + Retry-After). Git identity в этом репозитории не был настроен — задал ЛОКАЛЬНО `NeiP4n <isakoveugene0@gmail.com>`.
- Push не делал ни в одном.

---

## Задача (20.10.2026)
Кнопка «Очистить все сессии» внизу ЛЕВОЙ панели opencode-pp (TUI) с подтверждением, подсветкой при наведении. Владелец просил НЕ прогонять удаление по-настоящему (у него нужные сессии) — удаление на реальных данных не запускалось.

ВАЖНО О ДВУХ ДЕРЕВЬЯХ: рабочее opencode-pp — это `C:\Users\Isako\AppData\Local\opencode-pp\src`, ОТДЕЛЬНЫЙ git-репозиторий, ветка `groups-president`. `Desktop\Projects\opencode-pp` — другое дерево, ветка `lan-rooms` (там групповой чат сделан иначе: агент orchestrator). Правило «правку из (2) в (1) не тащить» касается дизайна группового чата; фича очистки сессий от дизайна не зависит, поэтому её нужно иметь в обоих.

## Что сделано
- `packages/tui/src/util/clear-sessions.ts` (новый): `listEverySession(api)` — все сессии всех проектов (без directory/project), активные + архивные, постранично по cursor; `removeEverySession(api, sessions)` — удаление по одному, ошибки собираются, а не роняют прогон.
- `packages/tui/src/component/clear-sessions.tsx` (новый): `ClearSessionsAction` — кнопка внизу левой панели (id `project-tree.clear-sessions.action`). Клик → список сессий → `props.confirm(...)` с числом сессий в тексте → при отказе ничего не удаляется → при согласии уход с текущей сессии (`leaveCurrentSession`) → удаление → тост («Удалено N сессий» / «Удалено N из M; K не удалось»).
  - Покрас: в покое `theme.text.feedback.error.base`; при наведении фон `theme.background.action.destructive.hovered` + текст `theme.text.action.destructive.hovered` (тема сама требует такого сочетания).
- `packages/tui/src/component/project-tree.tsx`: импорт `DialogConfirm` + `ClearSessionsAction`, хелпер `confirmClear` (ответ диалога срабатывает один раз: confirm/cancel/close), рендер `<ClearSessionsAction …/>` сразу после `</scrollbox>` — в самом низу левой панели.
- `packages/tui/src/util/i18n.ts`: русские переводы новых строк (секция «Session cleanup»).
- `packages/tui/test/clear-sessions.test.tsx` (новый): 5 headless-тестов на фейковом клиенте (сеть не трогается): кнопка рендерится, при наведении цвет меняется, отказ в подтверждении ничего не удаляет, подтверждение удаляет все сессии и уходит с текущей, отказ сервера попадает в отчёт.

## ГЛАВНЫЕ ГРАБЛИ (оба уже исправлены)
1. **Кнопка была невидимой.** Надпись красилась `theme.text.action.destructive.base`, а в теме void-signal этот токен = `selectedForeground(theme, theme.error)` = цвет фона темы. Замерено headless-рендером с файлом темы `~/.config/opencode/themes/void-signal.json`: фон панели #141414, destructive #0a0a0a (невидимо), `text.feedback.error.base` #e06c75 (видно). Фикс: цвет надписи = `text.feedback.error.base`. Общее правило: `text.action.destructive` — цвет текста ПОВЕРХ destructive-фона, а не на панели (см. комментарий в notes-panel.tsx). Тем же невидимым цветом рисуются «×» у комнат/групп в project-tree.tsx — чужая зона, не трогал.
2. **Правку затирал чужой деплой (17:02):** живой `project-tree.tsx` перезаписали чужой (старой) версией — кнопка пропала («БЫЛА И СНОВА ПРОПАЛА»). Мои отдельные файлы уцелели: деплой затирает только те файлы, которые меняет та команда. Урок: правку в общем файле нельзя оставлять незакоммиченной. Теперь она в истории ОБОИХ репозиториев.

## Проверка (факты)
- `bun test test/clear-sessions.test.tsx` → 5 pass / 0 fail в рабочем дереве (`AppData\Local\opencode-pp\src`) и в `Desktop\Projects\opencode-pp`.
- `bun typecheck` (packages/tui): по моим файлам ошибок НЕТ. В пакете 45 ошибок, все предсуществующие: 40 в `../core/src/plugin/internal.ts`, 3 в `../core/src/plot.ts`, 1 в `src/component/hover-action.tsx`, 1 в `test/util/session.test.ts`.
- Живой кадр из `test/project-tree.test.tsx` (Desktop) показал кнопку в нужном месте: под «No rooms yet…» строкой «Clear all sessions».

## Коммиты
- Рабочее дерево (`AppData\Local\opencode-pp\src`, ветка groups-president): `56ad2592c` — компонент, util, проводка в project-tree.tsx, переводы, тест (369 строк). Чужой незакоммиченный WIP (35 файлов) не тронут.
- `Desktop\Projects\opencode-pp` (lan-rooms): `dd3efc9dcc` (файлы+переводы), `d2b21b8d93` (проводка в project-tree.tsx — 36 строк, чужой WIP в том же файле не тронут), `d08005e0bb` (подсветка при наведении).
- Push не делал ни в одном репозитории: pre-push хук `bun run check` красный из-за предсуществующего typecheck-бага в core (L-025). Команда: `git push --no-verify origin <branch>`.

## Ключевые факты по развёртыванию
- Живой opencode: `AppData\Local\opencode-pp\bin\opencode-pp.cmd` → bun исполняет TS напрямую из `...\src\packages\cli\src\index.ts`. Правки TUI видны только после перезапуска TUI.
- `AppData\Local\opencode-pp\src` — git-репозиторий (ветка groups-president); `Desktop\Projects\opencode-pp` — другой репозиторий (lan-rooms). Перед копированием всегда `diff`; коммитить только свои пути, чужой WIP не трогать.
- Внимание: НЕ открывать файл на запись до проверки содержимого — в 17:20 мой скрипт так обнулил живой project-tree.tsx (восстановлен через `git show HEAD:packages/tui/src/component/project-tree.tsx > <live>/...`).

## Следующий шаг
- Владельцу: перезапустить TUI → внизу левой панели красная надпись «Clear all sessions», при наведении подсвечивается; по желанию `git push --no-verify origin groups-president` в рабочем дереве.

---

# 2026-10-20 — L-040: групповой чат живёт в ГРУППЕ (backend-часть, ветка groups-president)

## Задача
Групповой чат (Президент в lead / Общество в council) не должен жить в каталоге координатора-проекта.
Своя директория группы + серверное создание чата + federation-инструмент по явному scope (group|project).

## Что сделано (мои файлы)
- `packages/schema/src/federation.ts`: `GroupSupervisorMetadataKey` ("opencode-pp:group-supervisor"), `GroupSupervisorMetadata` (groupName/leader/mode), декодер `groupSupervisor(metadata)`, `GroupBootstrapMetadataKey` ("opencode-pp:group-supervisor-bootstrap").
- `packages/schema/src/orchestra.ts`: `groupSupervisorPermissions()` → deny "*" + federation ask + question allow (findLast в Permission.evaluate).
- `packages/core/src/federation.ts`: `groupChatDirectory(name, data=Global.Path.data)` = `<data>/group/<slug>-<fnv1a>`; сервис `ensureGroupChat({name, projects, mode})` — mkdir, проверка предков на .git/.hg (fs.up), идемпотентность (сессия `ses_group_<fnv1a(mode:name)>` + зарегистрированный supervisor), best-effort `Session.move` для legacy, setGroup, bootstrap-промпт (resume:false, metadata=bootstrap key). `setGroup` вынесен в локальную функцию; маркер читается декодером схемы, а не строковым литералом.
- `packages/core/src/orchestra.ts`: `isGroupChat()` — owns()/projectSessions() пропускают сессии с маркером группы, если нет owner-записи в KV.
- `packages/core/src/tool/plugin/federation.ts`: явный `Scope` = {kind:"group"|"project"}; group-ветка: peers/policy/linked — координатор, отфильтрованные по участникам; inbox/outbox — только по участникам; group_status — только свой чат; send/decide/reply/set_policy/link/unlink/set_group/remove_group/link_group запрещены с текстом; contribute/report_president — как раньше (project scope). Поведение проекта не изменено.
- `packages/protocol/src/groups/orchestra.ts` + `packages/server/src/handlers/orchestra.ts`: `POST /api/orchestra/group/:name/chat`, payload `{mode?}`, ответ `{sessionID, title, directory}`; режим берётся из СОХРАНЁННОЙ группы, несовпадение payload.mode → 400.
- `packages/client`: `bun run generate` → 4 сгенерированных файла (api.ts, generated/client.ts ×2, types.ts). Вручную не правил.

## Новые тесты
`packages/core/test/federation.test.ts` (+6): чат в каталоге группы (не равен каталогам участников, существует на диске); owns(координатор)=false и чата нет в sessions(координатора); идемпотентность (тот же sessionID/каталог); legacy-чат в каталоге координатора тоже не принадлежит проекту; reportToPresident доставляет отчёт в чат группы; стабильность groupChatDirectory.
`packages/schema/test/federation.test.ts` (+2): декодер маркера, публичный идентификатор.

## Проверка (факты)
- baseline core typecheck: 46 ошибок (38 в src/plugin/internal.ts, 8 в тестах) — все от чужого WIP. ПОСЛЕ правок: те же 46, ни одной в моих файлах.
- schema: 1 ошибка (test/room-rules.test.ts) до и после. tui: 41 до и после. protocol: 0. server: 42 (38 core/internal.ts + 4 room.ts), в моём handlers/orchestra.ts — 0. client: 0.
- `cd packages/core && bun run script/test.ts test/federation.test.ts` → 20 pass / 0 fail.
- `cd packages/schema && bun test` → 116 pass / 6 fail, все 6 предсуществующие (2× ENOENT из-за Windows-пути `new URL("../src").pathname`, 4 в room-rules: hideScreenshots/протектед-файлы). Мои тесты в schema/test/federation.test.ts — 14 pass / 0 fail.

## ГРАБЛИ
1. `yield* Global.Service` / `yield* FSUtil.Service` в тесте не работают, если сервис не выведен в LayerNode.group (Global заменён tempGlobalLayer → сервис не экспонирован). FSUtil.node надо добавить в группу явно.
2. `expect(session.location.directory).toBe(chat.directory)` — тип-ошибка: b.randed AbsolutePath против string. Лечится `String(...)`.
3. `it.live` требует Effect-тело; чистый sync-тест падает с "Not a valid effect: undefined" → обернуть в Effect.sync.

## Следующий шаг
- @coder2: TUI зовёт `client.api.orchestra.group.chat({ name, mode })`; дедуп по group.supervisor; ошибка смены режима — тост. L-041.
- Не коммитить: чужой WIP в рабочем дереве.

---

# 2026-10-20 — L-042/L-043: панель Реестра (TUI), ветка groups-president

## Задача
Доработка правок панели Реестра по ревью (только `packages/tui/src/component/devtools-registry.tsx`
и `packages/tui/test/component/devtools-registry.test.tsx`).

## Что сделано (мои правки в этой сессии)
- P1: `maxHeight={Math.max(1, dimensions().height - 3)}` — пол 12 убран (в терминале ≤ 12 строк панель
  была выше кадра). Комментарий объясняет -3: диалог добавляет `paddingTop={1}` (src/ui/dialog.tsx:84),
  плюс должны остаться видимыми строка заголовка и ряд вкладок.
- P2: закреплённая подсказка зависит от вкладки: programs — «enter install/remove · ←→ page»,
  plugins — «enter enable/disable», остальные — «enter install/remove». Дубликат подсказки внутри
  прокручиваемой области PluginTools удалён (закреплённая её покрывает).
- P2: три эффекта «курсор → scrollChildIntoView» вынесены в общий `scrollCursorIntoView(cursor, idOf, scrollIntoView)`,
  комментарий один. Поведение идентично прежнему (та же индексация выбранной строки).
- P2: `createEffect(on(tab, () => scroll?.scrollTo(0), { defer: true }))` — defer + то же объяснение.
- P2: `onCleanup(() => { scroll = undefined })` рядом с объявлением ref на scrollbox.
- Тесты: новый случай с терминалом 10 строк; проверки через `frameOffenders()` (список строк-нарушителей)
  вместо `expect(drawn.every(...)).toBe(true)`; новый случай «подсказка соответствует вкладке».
- i18n-base.ts НЕ тронут: строка «tab next tab · ↑↓ select · enter enable/disable · esc close» уже была
  переведена в `src/util/i18n.ts` (ruExtra, строка 179), а `useT` из "../util/i18n" сначала смотрит ruExtra.

## ГРАБЛИ / ФАКТЫ
- `captureCharFrame()` отдаёт буфер размером ровно высота терминала + 1 пустая строка (лишний перевод строки).
  Поэтому старая проверка `drawn.every(item => item.y < size.height)` была ТАВТОЛОГИЕЙ: буфер физически не может
  выйти за кадр, а переполнение видно только как ОБРЕЗАННЫЙ контент (пропала нижняя подсказка).
  Ловится это проверкой «строка подсказки присутствует в кадре», а не сравнением индексов.
- При высоте 10 строк с полом 12 панель не обрезалась сверху, а уезжала вниз: заголовок и вкладки были видны,
  а подсказка «tab next tab» пропадала из кадра. Новый тест это и ловит (падение называет виновника: `["hint"]`).
- Две таблицы переводов: `i18n-base.ts` (база) и `i18n.ts` (ruExtra поверх базы). Проверять перевод через
  `translate("ru", key)` из `src/util/i18n`, а не по наличию ключа в i18n-base.

## Проверка (факты, из этой сессии)
- `cd packages/tui && bun typecheck` → exit 0, без ошибок.
- `cd packages/tui && bun test test/component/devtools-registry.test.tsx` → 16 pass / 0 fail (было 14 до двух новых тестов).
- `cd packages/tui && bun test test/devtools-registry-open.test.tsx` → 0 pass / 1 fail: `unexpected request: /api/room/mesh`
  (в фикстуре `test/fixture/tui-client.ts` нет мока для mesh-эндпоинта; запрос идёт из LAN-Mesh фичи, не из панели
  Реестра). Это чужой долг, не чинил.
- ЛОВИЛЬНОСТЬ (проверено): вернул пол 12 → новый тест «very short terminal» ПАДАЕТ (`["hint"]`).
  Убрал обёртку scrollbox → падают 3 теста (оба коротких терминала + «AI tools open first…»).
  После возврата `git diff --stat` совпал с исходным (450 / 170 строк), i18n-base.ts — пустой diff.
- Коммит НЕ делал (в дереве чужой незакоммиченный WIP), ничего не откатывал.

## ГРАБЛИ (полный прогон TUI)
- Полный `bun test` в packages/tui: 1372–1392 pass / 115–128 fail / 252–369 errors — ПРОМЕНЯЕТСЯ от прогона к прогону
  (счётчики разные), и 222 раза всплывает `room/mesh failed`. Причина — кросс-файловая утечка: `project-tree.tsx:61`
  и `dialog-rooms.tsx` опрашивают `client.api.room.mesh`, а фикстура `test/fixture/tui-client.ts` этот путь не мокает;
  запрос утекает из теста, оставшегося живым, и валится на следующем тесте. Виновны 13+ файлов
  (team-editor, stats.view, shell-badge, session-outline-jump, …), не только реестр.
- Доказательство, что это НЕ моя регрессия: пара `app-lifecycle + devtools-registry` с файлами на HEAD
  (до правок) даёт 8 pass / 36 fail, а с моими правками — 25 pass / 22 fail. В изоляции файл реестра: 16/16.
- `git stash push -- <пути>` в этом репозитории переписывает файлы в CRLF (core.autocrlf=true) — после `stash pop`
  вернуть LF пришлось отдельной нормализацией; содержимое сверено с резервной копией (идентично).

## Следующий шаг
- @tester: независимая проверка `cd packages/tui; bun test test/component/devtools-registry.test.tsx` + `bun typecheck`.
- L-042 остаётся IN_PROGRESS: шаги 4 (живая проверка в dev:live) и 5 (сборка и установка глобального бинаря) — не мои.



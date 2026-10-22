---
title: Android-сборка: рамка, два пути (A/B), блокеры, критерии приёмки
status: active
tags: [android, apk, scope, app]
length: detailed
created: 1792276354421
updated: 1792276354421
---

# Android-сборка: рамка (задача L-722)

Статус брифа: read-only разбор репозитория. Сборка не запускалась (нет shell), внешние
документы не сверялись (fetch/websearch недоступны в сессии). Каждое утверждение помечено:
**[ИСХОДНИК]** = прочитан файл с номером строки; **[ВЫВОД]** = рассуждение;
**[НЕ ПРОВЕРЕНО]** = требует прогона или внешней доки.

Запрос владельца дословно: «в apk ветке сделать андроид сборку нормальную полную» +
«необходимо полностью допилить его и забилдить релиз».

---

## 0. Что уже есть и чего нет

- Android-инфраструктуры нет: `glob **/android/**` даёт только иконки (§1.5),
  ни `build.gradle`, ни `AndroidManifest.xml`, ни `capacitor.config.*`.
  grep `android|apk|capacitor|gradle|java-version` по `.github/` → 0 совпадений. **[ИСХОДНИК]**
- `.github/` существует (37 workflow/issue-файлов), но Android-строки нет ни в одном. **[ИСХОДНИК]**
- Корень — Bun workspace, `packageManager: bun@1.4.2`, версия 2.0.24. **[ИСХОДНИК]** `package.json:3,8`
- Проверка проекта: `bun run check` = `lint && typecheck`. Тесты из корня запрещены
  (`"test": "echo 'do not run tests from root' && exit 1"`). **[ИСХОДНИК]** `package.json:29,37`

---

## 1. Инвентарь поверхностей

### 1.1 packages/app — единственный кандидат на APK

Доказательства:

| Факт | Файл:строка |
|---|---|
| сборка = vite, одна точка входа | `packages/app/package.json:19`, `index.html:26` |
| рантайм-обёртка `web`, без node-API | `packages/app/src/entry.tsx:52` → `createWebPlatform(pkg.version)` |
| в `packages/app/src` ноль импортов `node:` | grep `from "node:"` → 0 совпадений |
| существует ровно два платформенных рантайма: web и desktop | `packages/app/src/runtime/platform/platform.tsx:22` `type PlatformName = "web" \| "desktop"` |
| мобильный веб — первоклассная цель | `index.html:12,14-16`: `site.webmanifest`, `mobile-web-app-capable`, `apple-mobile-web-app-capable` |
| мобильные раскладки | `home/route.tsx:14`, `composer/composer.tsx:73`, `shell/titlebar/titlebar.tsx:65` — `createMediaQuery("(max-width: 767px)")` |
| виртуальная клавиатура обработана | `packages/app/src/runtime/platform/keyboard.ts:3-24` `KeyboardInsets` |
| сервер отдаёт тот же самый бандл | `packages/cli/src/services/web-ui.ts:29,33-52` (`serveUI`, `assets["index.html"]`) |

**Что требуется от платформы:** только браузерные API — `fetch`, `localStorage`,
`Notification`, `getUserMedia`. Ни ФС, ни PTY, ни процессов. **[ВЫВОД]**

### 1.2 packages/web — не приложение

`packages/web/package.json:7,15-16` — Astro + Starlight, деплой документации
(`@astrojs/cloudflare`). Точка входа — контент, а не UI приложения. Отклонён. **[ИСХОДНИК]**

### 1.3 packages/tui — терминал, не экран

`packages/tui/package.json:61-63` — `@opentui/core`, `@opentui/keymap`, `@opentui/solid`;
рисование идёт в терминал. Для APK нужен терминал-поверхность: на телефоне её нет.
Отклонён как поверхность APK; как **просмотрщик** вывода инструментов остаётся применим
через `packages/session-ui`. **[ИСХОДНИК + ВЫВОД]**

### 1.4 packages/desktop — Electron

`packages/desktop/package.json:53` — `electron 44.4.5`; main/preload/renderer
(`packages/desktop/AGENTS.md`: renderer ходит в main только через `window.electron`).
Electron не имеет Android-таргета. Отклонён. **[ИСХОДНИК]**

### 1.5 packages/ui, packages/session-ui — библиотеки, не приложения

`packages/session-ui/package.json:6-47` — все экспорты это компоненты/стили
(`./timeline`, `./markdown`, `./v2/*.tsx`). Они входят **внутрь** бандла packages/app,
самостоятельным APK не являются. **[ИСХОДНИК]**

### 1.6 Находка: Android-иконки уже есть

`packages/desktop/icons/{dev,beta,prod}/android/` — `mipmap-mdpi…xxxhdpi/ic_launcher.png`,
`ic_launcher_round.png`, `ic_launcher_foreground.png`, `mipmap-anydpi-v26/ic_launcher.xml`
(adaptive), `values/ic_launcher_background.xml`. `packages/app/vite.icons.ts:13` уже берёт
`android/mipmap-xxxhdpi/ic_launcher.png` для веб-манифеста.
→ Для APK не нужно рисовать иконку заново. **[ИСХОДНИК]**

---

## 2. Сравнение путей

### Путь A — телефон как клиент (WebView-обёртка)

Работает поверх того, что уже сделано: приложение уже является веб-клиентом удалённого
сервера. `README.md:86-102` описывает режимы `none`/`origin` и полноэкранную форму
подключения. Сервер сам отдаёт SPA: `packages/cli/src/commands/handlers/serve.ts:10-15`
→ `ServerProcess.run({ hostname, port, cors })`; `server-process.ts:65` дефолт `127.0.0.1`
(для телефона нужен `--hostname 0.0.0.0`).

**Надо написать с нуля:**
1. gradle-проект (или `capacitor init`) — сейчас нет ничего.
2. `AndroidManifest.xml`: `INTERNET`, при HTTP-LAN `usesCleartextTraffic`, иконка из §1.6.
3. Activity с WebView на URL сервера + обработка `onPermissionRequest` для камеры.
4. Экран/поле ввода адреса сервера и приём `opencode pair`-ссылки — в приложении форма
   уже есть (`packages/app/src/servers/connect/screen.tsx`), но в голом WebView её нет,
   значит нужен свой вход.

**Два подварианта:**
- **A1** — WebView грузит **удалённый URL**. Бандл в APK не кладём. Обновление UI = обновление
  сервера. НО: APK тогда почти неотличим от PWA/иконки, его ценность = иконка + фуллскрин.
- **A2** — бандл кладём **внутрь APK**, сборка с `VITE_ORCHESTRA_SERVER_MODE=none`
  (`packages/app/src/env.d.ts:2`, `packages/app/README.md:86-93`), пользователь сам добавляет
  сервер формой. Тогда версия APK и версия сервера расходятся — проверки совместимости
  в коде я не нашёл **[НЕ ПРОВЕРЕНО]**.

### Путь B — телефон как всё сразу (Bun + server + core на устройстве)

**Это не задача упаковки, это порт нативного слоя на Android.** Блокеры по
`packages/core/package.json:105-121` и `:83-90`, `packages/cli/package.json:60-79`:

| Зависимость | Что это | Готовые бинари | Android? |
|---|---|---|---|
| `@lydell/node-pty` | нативный PTY | darwin-arm64/x64, linux-arm64/x64, win32-* | нет |
| `@parcel/watcher` + 7 `@parcel/watcher-*` | нативный следитель за ФС | darwin, linux (gnu/musl), win32 | нет |
| `@ff-labs/fff-bun` / `fff-node` + `@ff-labs/fff-bin-*` | нативный быстрый ФС | darwin, linux, win32 | нет |
| `@silvia-odwyer/photon-node` | нативная обработка изображений | — | нет |
| `@vscode/ripgrep` | бинарь ripgrep | по платформам | нет |
| `@yuuang/ffi-rs-*` | FFI | darwin, linux, win32 | нет |
| `tree-sitter-bash` / `tree-sitter-powershell` | wasm/native парсеры оболочки | — | под вопросом |

Плюс сам рантайм: сервер — это `Bun.serve` (`packages/cli/src/gateway.ts:650`) и
`bun:sqlite` (условие `bun` в `packages/core/package.json` `imports["#sqlite"]`).
**[ИСХОДНИК]** по зависимостям, **[НЕ ПРОВЕРЕНО]** по наличию/отсутствию сборок Bun под Android.

Объём B: до первой строки APK-кода нужно (1) собрать под android-arm64 через NDK ≥4
нативных модулей, (2) получить или собрать рантайм Bun под Android, (3) решить, где живут
рабочие каталоги агента. Это отдельный проект размером больше самой задачи.

---

## 3. Блокеры, названные точно

### B1. Камера / qr-scanner
- `packages/app/src/servers/connect/camera.ts:6`:
  `platform.platform === "web" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia`.
  `entry.tsx:52` даёт `platform: "web"` → условие платформы выполнено.
- **Решающий фактор — `window.isSecureContext`.** При загрузке из `https://…` истина;
  при `file:///android_asset` (голый WebView без схемы) — ложь, и QR-сканирование
  выключается целиком. Тогда единственный вход — вставка pair-ссылки
  (`README.md:99-100`, `redeem.ts:17-45`).
- Требуется Android-часть: разрешение `CAMERA` в манифесте, запрос в рантайме,
  обработчик `WebChromeClient.onPermissionRequest` (без него `getUserMedia` не выдаётся).
  Что именно Capacitor делает с `getUserMedia` — **[НЕ ПРОВЕРЕНО]**, читать
  `capacitorjs.com/docs/guides/...` и раздел permissions.
- CSP: `packages/cli/src/services/web-ui.ts:83-85` уже разрешает `worker-src 'self' blob:`
  специально под qr-scanner — при A1 это работает как есть. **[ИСХОДНИК]**

### B2. vite-plugin-pwa / service worker
- `packages/app/src/entry.tsx:54-56`: в PROD на `load` регистрируется `/sw.js`.
- `packages/app/vite.pwa.ts:16-55`: `generateSW`, `globPatterns: ["**/*"]`,
  `navigateFallback: "/index.html"`, `navigateFallbackDenylist` для `/api`, `/auth`.
- При **A1** SW не проблема: сервер и так отдаёт `/sw.js` (`web-ui.ts:52`).
- При **A2** (бандл внутри APK, origin `file://`) SW не поддерживается — регистрация
  бросит исключение. Точный текст ошибки на Android WebView — **[НЕ ПРОВЕРЕНО]**,
  нужен официальный источник по service worker в WebView.

### B3. Файловая система проекта
- Инструменты агента читают/пишут на **хосте сервера**, не на телефоне.
  Клиент ФС не касается: grep `from "node:"` по `packages/app/src` → 0.
- Для пути A это **не блокер**, а следствие: телефон = пульт.
- Для пути B это и есть предмет порта.

### B4. Терминал packages/tui
- Рисует в терминал через `@opentui/core`. На Android нет поверхности TTY для него.
- В APK не будет: интерактивного терминала, persistent PTY, split-pane терминала.
  Что останется: просмотр того, что сервер уже отрисовал как tool-части в ленте сессии.

### B5. Хранение пароля сервера
- `packages/app/src/runtime/server/api.ts:5-7,29-34`: пароль превращается в
  `Authorization: Basic base64("opencode:" + password)`.
- Где лежит: `packages/app/src/runtime/server/persistence.ts:6-9` — `ServerHttpBase.password`
  входит в персистентное состояние; для web-платформы
  `packages/app/src/runtime/persistence/storage.ts:625-627,677-678` → **localStorage**.
- Итог: на Android пароль сервера лежит открытым текстом в приватном хранилище WebView.
  Keychain/EncryptedSharedPreferences в репозитории нет **[ИСХОДНИК: отсутствует]**.
  Это решение владельца, а не техническая деталь.

### B6. SSE / streaming
- `packages/client/src/solid/connection.ts:97` — подписка на поток событий через fetch
  c `onActivity`; `:35` `defaultIdleTimeout = 45_000`; `:38` `foregroundIdleThreshold = 20_000`;
  keepalive сервера 15 с (комментарии `:22-24`, `:84-85`); `resync` на `:214`.
- Что будет на Android: при сворачивании экрана таймеры WebView приостанавливаются
  (Doze/фоновые ограничения), watchdog увидит тишину и переподключит поток.
  **[ИСХОДНИК]** по механизму watchdog; **[ВЫВОД]** про поведение Android — нужен прогон.
- Отдельно: долгоживущий SSE в WebView — не то, под что Android проектирует фоновую
  работу; без FCM уведомлений приложение в фоне не «разбудит».

### B7. Уведомления
- `packages/app/src/runtime/platform/web.ts:17-39`: Web `Notification` API, и `:27` —
  ранний выход, если страница в фокусе. В APK это фактически пусто; FCM нет.
  **[ИСХОДНИК]**

---

## 4. Критерии приёмки (каждый проверяем прогоном)

Все критерии — на пути A. Для B большая часть невыполнима в текущем виде (§2).

| # | Критерий | Чем доказывается | Как может упасть |
|---|---|---|---|
| AC-1 | gradle-сборка даёт `.apk` | `cd packages/android && ./gradlew assembleDebug` → код 0, файл `app/build/outputs/apk/debug/app-debug.apk` ненулевой | нет JDK/SDK/NDK на машине сборки; нет gradle-проекта вообще |
| AC-2 | APK ставится на эмулятор | `adb install -r app-debug.apk` → `Success` | подпись/ABI mismatch, minSdk выше эмулятора |
| AC-3 | Приложение открывается и рисует экран | `adb shell am start -n <pkg>/.MainActivity`, затем скриншот: виден не белый экран | WebView не грузит, CSP, JS-ошибка в консоли WebView |
| AC-4 | Экран подключения виден без сервера | тот же скриншот: форма адреса/пароля | (A1) сразу грузится удалённый сервер и форма не нужна — критерий применим к A2 |
| AC-5 | Вход в сервер с телефона | ввести URL+пароль работающего `opencode serve --hostname 0.0.0.0`, дождаться списка сессий | телефон в другой сети; `127.0.0.1` по умолчанию; нужен HTTPS или cleartext-разрешение |
| AC-6 | Агент отвечает, текст стримится | отправить промпт; символы появляются по мере генерации | watchdog 45 с, обрыв SSE, Doze |
| AC-7 | Стрим переживает сворачивание экрана | свернуть на 60 с, развернуть, стрим обязан продолжиться без ручного рефреша | сетевая заморозка Android, тишина > 45 с без keepalive |
| AC-8 | QR-вход работает | `opencode pair`, навести камеру телефона на QR | `isSecureContext`; разрешение `CAMERA`; `onPermissionRequest` |
| AC-9 | Пароль сервера не в открытом виде (если принято решение) | проверить хранилище приложения: в localStorage нет строки `opencode:` | сейчас пароль в localStorage — критерий упадёт по умолчанию |
| AC-10 | APK переживает холодный старт без сети | включить авиарежим, запустить — приложение открывается и объясняет, что сервер недоступен | падение на `check()` без таймаута |
| AC-11 | Отпечаток APK воспроизводим | две сборки одного коммита → `sha256sum` совпадает (кроме полей подписи) | время в манифесте, случайный порядок ресурсов |
| AC-12 | Релиз в GitHub создан, APK из него ставится | `gh release create` + скачивание вложения + `adb install` скачанного файла | в репозитории 0 тегов и 0 релизов — прецедента нет |

Явно непроверяемое прогоном в этом виде и потому исключено: «приложение работает быстро»,
«выглядит нативно», «удобно на телефоне» — для них нужны живые пользователи, а не критерий.

---

## 5. Рекомендация

**Взять путь A.** Обоснование: единственная поверхность, которая реально является
приложением, — `packages/app`, и она уже написана как браузерный клиент без единого
node-импорта. Сервер уже отдаёт этот бандл. То есть A — это обёртка над готовым продуктом,
а не новый продукт.

**Но A1 — это пульт, и это надо сказать прямо.** Телефон не выполняет агента, не имеет
инструментов, не имеет ФС проекта, не имеет терминала. Он показывает и отправляет.

Что A1/A2 **не умеет** (список, без сглаживания):
- не запускает агента на телефоне (путь B — единственный, кто это умеет, и он сейчас заблокирован);
- не показывает интерактивный терминал packages/tui;
- не даёт офлайн-работы: без сети до сервера приложение — пустая форма;
- не хранит пароль сервера в keychain (сейчас localStorage, §B5);
- не присылает push-уведомлений (FCM нет, §B7);
- A2 дополнительно: расхождение версий APK и сервера без проверки совместимости.

**Отдельная рекомендация, которую надо вынести владельцу:** если нужна «opencode на телефоне»
без APK, PWA-установка («Добавить на главный экран») даёт это нулём нового кода — в `index.html`
уже есть `manifest` и `mobile-web-app-capable`. APK оправдан только если нужны фуллскрин
immersive, отсутствие адресной строки браузера, стабильная иконка и будущие нативные
фичи (share-sheet, deep-link, push). Это развилка, а не техническая деталь.

**Что дешевле всего сделать до gradle:** зафиксировать одно решение владельца — «клиент или
агент». Всё остальное следует из него.

---

## 6. Открытые вопросы и предлагаемые умолчания

| Вопрос | Предлагаемое умолчание |
|---|---|
| Клиент или агент на телефоне? | клиент (путь A) |
| Где живёт сервер? | машина владельца, доступ по LAN или туннелю |
| Нужен ли офлайн? | нет |
| Где хранить пароль сервера? | localStorage, риск зафиксировать явно; keychain — отдельная задача |
| `versionName` / `versionCode` | `2.0.24` из корневого `package.json`; `versionCode` — номер сборки |
| Подпись | debug-подпись для внутреннего использования; релизный keystore — отдельная задача |
| Канал иконки | `beta` — готовые иконки есть в `packages/desktop/icons/beta/android/` |
| Где лежит код Android? | новый пакет `packages/android`, чтобы не смешивать с `packages/app` |

---

## 7. Что НЕ проверено (честный список)

1. Ни одной сборки не запускалось — shell в сессии отсутствует. Все утверждения о поведении
   приложения на Android основаны на исходниках, не на прогонах.
2. Внешние доки не сверялись: fetch/websearch/browser были недоступны. Не проверены:
   требования Capacitor к JDK/SDK; поведение `getUserMedia` в WebView и плагин камеры;
   service worker на origin `file://`; наличие сборок Bun под Android; политика Android по
   фоновым SSE.
3. `gh release list` и количество тегов не перепроверялись в этой сессии (только из брифа владельца).
4. Размер `dist` packages/app не измерялся; заявленные «~52 МБ офисных движков»
   (`vite.pwa.ts:6-9`) — это комментарий в коде, а не измеренный факт.
5. Нет ли уже проверки совместимости версий APK↔сервер — не искал целенаправленно (помечено как `[НЕ ПРОВЕРЕНО]` в §2).
6. Не проверялось поведение `servers/connect/screen.tsx` в голом WebView без Solid-приложения —
   скорее всего её придётся писать заново в нативном виде, но это вывод.
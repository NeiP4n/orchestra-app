---
title: Android-сборка: декомпозиция на части с непересекающимися файлами (L-724)
status: inbox
tags: []
created: 1792276931573
updated: 1792277091952
---

# Android-сборка: декомпозиция (задача L-724)

Дата: 18.10.2026. Ветка: `apk` (локальная, трекает `origin/apk`).

ПОПРАВКА от 18.10.2026: в первой версии этой заметки было написано, что tip ветки —
`3a7817552`. Это неверно: я прочитал перемешанный вывод двух команд `git log` подряд.
Реально `git rev-parse --short origin/apk`, `origin/lan-rooms` и `HEAD` дают одно и то же:
**37504215c**. Рабочее дерево переведено на локальную ветку `apk` именно с этого коммита.

Рамка (путь A2, рекомендация брифа `.opencode/notes/android-build-frame.md`): телефон = клиент,
веб-бандл `packages/app` зашивается в APK, сервер пользователь добавляет штатной формой приложения.

## Проверенная база (не из памяти, а командами)

| Факт | Команда / источник | Результат |
|---|---|---|
| Android-проекта в репозитории нет | `glob **/{build.gradle*,AndroidManifest.xml,capacitor.config.*}` | 0 файлов |
| Бандл приложения собирается | `bun run build` в `packages/app` | 9.73 s, `dist/` + `sw.js`, precache 1618 entries ≈35 МБ |
| `apk` и `lan-rooms` на одном коммите | `git rev-parse --short origin/apk origin/lan-rooms HEAD` | все три: 37504215c |
| Иконки Android готовы | `packages/desktop/icons/beta/android/` | mipmap mdpi…xxxhdpi + anydpi-v26 + values |
| CI жив | `gh run list` | test/check/quality-gates идут по `lan-rooms` |
| Репозиторий публичный, дефолт `lan-rooms` | `gh repo view` | PUBLIC |
| На машине не было Android SDK | `which adb`, `which gradle`, `$env.ANDROID_HOME` | пусто; был только JDK 21 |

## Пин тулинчей (сверено с dl.google.com и developer.android.com 18.10.2026)

- cmdline-tools: `commandlinetools-win-16111833_latest.zip`, 155 МБ, HTTP 200
- AGP 9.4.0 → Gradle 9.6.0 (минимум и дефолт), build-tools 36.0.0, JDK 17+ (локально 21)
- platform: `android-36` (максимум в репозитории пакетов), platform-tools r37.0.1
- Нюанс: в cmdline-tools 23.0 `sdkmanager` помечен устаревшим, его заменил `android sdk install`
  (старый синтаксис `sdkmanager <package>` молча не ставит platform/build-tools — проверено, вывод был
  «Package platforms not found»)

Локально поставлено: `C:\Users\Isako\.local\share\android-sdk` — cmdline-tools 23.0,
platform-tools 37.0.1, platforms;android-36, build-tools 36.0.0. `packages/android/local.properties`
указывает `sdk.dir` (машинный файл, в git не идёт).

## Части, области файлов не пересекаются

### Часть 1 — тулчейн и CI · DevOps
Файлы: `packages/android/gradlew*`, `packages/android/gradle/**`, `packages/android/gradle.properties`,
`packages/android/scripts/**`, `packages/android/.gitignore`, `.github/workflows/android-apk.yml`.
Проверка запуском: `gradlew --version` → Gradle 9.6.0; список установленных пакетов SDK;
зелёный CI-ран на `apk` с артефактом `app-debug.apk`.

### Часть 2 — модуль приложения · Mobile Developer
Файлы: `packages/android/settings.gradle.kts`, `packages/android/build.gradle.kts`,
`packages/android/app/**`, `packages/android/README.md`.
Проверка запуском: `:app:assembleDebug` → непустой APK; `aapt2 dump badging` → package/versionName/
versionCode/permissions; внутри APK `assets/app/index.html` и `assets/app/sw.js`.

### Часть 3 — проверка артефакта · Tester (после частей 1 и 2)
Ничего не создаёт: разбирает APK и ставит его на эмулятор. Критерии AC-2, AC-3, AC-10, AC-11
из брифа; скриншоты как доказательство.

### Часть 4 — независимое ревью релиза · Reviewer (параллельно раскатке, до публикации)
Версия согласована во всех манифестах, нет ключей в дереве, версия внутри артефакта совпадает с
заявленной, путь отката существует.

### Часть 5 — публикация · DevOps (после 3 и 4)
`gh release create` с APK вложением; предыдущая версия остаётся точкой отката.

## Явно вне объёма этого захода

Путь B (Bun + core на устройстве), нативный терминал packages/tui, keychain для пароля сервера,
push-уведомления FCM, релизный keystore (отдельная задача, ключ только из CI-секрета).

## Открытые решения, которые может принять владелец

1. `applicationId` взят как `com.nei4pn.opencodepp`, label `OpenCode++` — если нужен другой, скажите.
2. A1 против A2: бандл внутри APK (расхождение версий APK и сервера) против WebView на удалённый URL
   (APK превращается почти в лаунчер). Взят A2.
3. Пароль сервера остаётся в localStorage WebView (известный риск брифа, §B5).
4. Подпись первого релиза — debug-keystore.
5. В репозитории ноль тегов и ноль релизов: у первого релиза нет предшественника для отката.

## Решения, принятые 18.10.2026 (ProcessController, ответ на их вопрос)

| Решение | Значение | Кто |
|---|---|---|
| Развилка | **A2** — бандл внутри APK, не A1 | владелец, через ProcessController |
| Обёртка | голый gradle + WebView, **не Capacitor** | владелец |
| `applicationId` | **`ai.opencode.plusplus`** (сменился с моего умолчания `com.nei4pn.opencodepp`) | владелец |
| Подпись | v1 — **debug-signed**, sideload владельцем; продакшн-keystore не заводим | владелец |
| Условие публикации | `gh release create` только при существующем git-теге на коммите сборки; имя по умолчанию `v0.1.0`, **согласовать** | владелец |
| Запреты | не тегать `apk`, не вливать в `lan-rooms`, не создавать PR до согласования имени тега | владелец |

Принятое следствие debug-подписи: при переходе на релизный ключ старую установку придётся
удалить — обновление поверх debug-подписи невозможно. Записано как осознанный риск.

Правило проекта «каждый коммит отдельным PR» (L-723) на это время перебито запретом владельца:
до согласования имени тега коммиты остаются локальными.

### Обязательный гейт приёмки: SSE/Doze
Прогон с выключенным экраном: вернулся ли клиент в живой поток или потребовал resync.
Не «должно работать», а записанный результат. Отражено на доске как **L-727** (ждёт L-725).
Ограничение: на машине нет ни эмулятора, ни реального устройства. Возможен CI-шаг с
эмулятором (экран гасится `adb shell input keyevent 26`, ожидание дольше idle-таймаута 45 с,
logcat + поведение watchdog'а). Настоящий Doze с сетевой заморозкой эмулятор не воспроизводит —
это доказывается только живым устройством. Уровень приёмки выбирает владелец.

### Известные риски, принятые как есть (не чиним в этом цикле)
- пароль сервера в localStorage как Basic base64, без Keychain/EncryptedSharedPreferences;
- кнопка «назад» закрывает приложение;
- уведомления без FCM;
- cleartext/HTTPS для LAN-сервера — наша часть, подключение должно просто работать.

### Ловушка при смене applicationId
Если Activity объявлена в манифесте со старым пакетом, `applicationId` и `android:name`
разойдутся и Activity не запустится. Проверяется только запуском, не чтением кода.

### Статус правки
На момент получения решения `packages/android/app/build.gradle.kts` ещё не существовал —
модуль дописывался. Правка на `ai.opencode.plusplus` будет применена до первой сборки APK;
в очередь к разработчику не встала (сессия занята), отправлю сразу после его отчёта.

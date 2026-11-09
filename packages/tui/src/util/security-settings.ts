import { Limits } from "@orchestra/core/limits"
import { BrowserBudget } from "@orchestra/core/browser/budget"
import { ENV_REGISTRY } from "@orchestra/core/env-registry"
export interface SecurityEntry { id: string; title: string; value: string; description: string }
/** Never enumerate or print environment values. Only these numeric/boolean flags are inspected. */
const flags = ["ORCHESTRA_DISABLE_LIMITS", "ORCHESTRA_ENFORCE_LIMITS", "ORCHESTRA_BROWSER_LOCAL_TEST", "ORCHESTRA_BROWSER_LIMIT", "ORCHESTRA_TEAM_MODEL_FALLBACK", "ORCHESTRA_MCP", "ORCHESTRA_MCP_ALLOW_CHROME_DEVTOOLS", "ORCHESTRA_MCP_ALLOW_PLAYWRIGHT"]
export function securitySettings(env: Record<string, string | undefined> = process.env): SecurityEntry[] {
  let browsers = "ошибка значения; запуск запрещён"
  try { const cap = env.ORCHESTRA_BROWSER_LIMIT === "off" ? Infinity : BrowserBudget.configuredMax(env.ORCHESTRA_BROWSER_MAX); browsers = cap === Infinity ? "без лимита" : String(cap) } catch {}
  const entries: SecurityEntry[] = [
    { id:"scope", title:"Источник значений", value:"локальный TUI", description:"Здесь показаны локальные параметры процесса TUI и известные механизмы. Окружение отдельного сервиса и его конфигурация могут отличаться. Этот экран не выдаёт локальные значения за подтверждённое состояние сервиса." },
    { id:"limits", title:"Защита времени и токенов", value:Limits.enforced(env)?"включена":"ВЫКЛЮЧЕНА · расширено", description:"Реальный Limits.enforced: ограничение шагов, tool timeout и drain budgets. Это не денежный cap. Меняется окружением процесса сервиса; здесь только чтение." },
    { id:"wall", title:"Время одного drain", value:Limits.drainWallClockMs(env) === undefined ? "без лимита" : `${Limits.drainWallClockMs(env)} мс`, description:"Действующее локальное значение ORCHESTRA_DRAIN_WALL_CLOCK_MS; default 4 часа. Сервис может иметь отдельное окружение." },
    { id:"tokens", title:"Токены одного drain", value:String(Limits.drainTokenBudget(env) ?? "без лимита"), description:"Оценка входных токенов одного drain, default 10000000. Это не ограничение стоимости." },
    { id:"browsers", title:"Активные профили браузера", value:browsers, description:"ORCHESTRA_BROWSER_MAX. Default без лимита по решению оператора. Один профиль может создавать несколько процессов Chrome. Проверки PID/CDP и launch lock остаются отдельными механизмами." },
    { id:"triggers", title:"Лимит триггера в час", value:"6 по умолчанию · индивидуально", description:"Расписания → Час → изменить: 1-10000 или явное «без лимита». Там видны фактический режим и счётчик каждого триггера. Этот экран не меняет их глобально." },
    { id:"trigger-day", title:"Суточный лимит триггера", value:"48 по умолчанию · максимум100", description:"Часовой unlimited не снимает суточный cap. История сохраняется при возобновлении." },
    { id:"trigger-gap", title:"Циклы и частота триггеров", value:"5 мин · browser60с · max20/проект", description:"Минимальная частота, ограничение числа триггеров, bounded queues и пауза после3последовательных ошибок local actions. Catch-up максимум3. Не отключаются часовым unlimited." },
    { id:"publish", title:"Публикация из триггера", value:"без отдельного да запрещена", description:"Triggered turn не может сам одобрить отправку и менять триггеры. BrowserAgent taint блокирует click/type/eval для triggered read-only задачи." },
    { id:"js", title:"JavaScript в браузере", value:"нет общего жёсткого OFF", description:"В коде есть browser eval с read-oriented проверками и фиксированные внутренние DOM scripts. Это не глобальный аппаратный запрет JS. Новое разрешение на произвольный JS здесь не выдаётся." },
    { id:"money", title:"Платные модели и деньги", value:"денежный cap не подтверждён", description:"Правило оператора: расход0 без отдельного согласия. Общее аппаратное ограничение стоимости0 не найдено; время/токены его не заменяют. Этот экран не включает платные модели и не выдаёт разрешение платить." },
    { id:"vault", title:"Vault и инъекция секретов", value:"оператор · ciphertext · injection не подключена", description:"Существующий Vault хранит шифротекст, catalog не раскрывает значения. Новый agent decrypt/inject bridge не реализован. Никаких секретов на этом экране." },
    { id:"pty", title:"ИИ во встроенной консоли", value:"bridge не подключён", description:"Агентский PTY bridge ещё не реализован. Запрошенные режимы off/read/подтверждение команды/full должны иметь backend guard, журнал и отзыв. Здесь нет фейкового переключателя и права не выдаются." },
    { id:"autoloop", title:"Autoloop: защита циклов", value:"attempts2 · verify5 · hops8 · same-error3", description:"Defaults ConfigOrchestra.Autoloop. Дополнительно retry5-60мин, run lease5мин, worker fresh2мин, offline10мин, batch1000ms/50events, unused tool prune10steps. Фактические core config overrides здесь не прочитаны." },
  ]
  for (const name of flags) if (ENV_REGISTRY[name]) {
    const raw = env[name]
    const value = raw === undefined ? "не задано" : ["0","1","true","false","off","on"].includes(raw) ? raw : "задано; значение скрыто"
    entries.push({ id:name, title:name.replace("ORCHESTRA_",""), value, description:`${ENV_REGISTRY[name].purpose} ${ENV_REGISTRY[name].default ? `Default: ${ENV_REGISTRY[name].default}` : ""} Только локальный процесс; меняется вне этого экрана.` })
  }
  return entries
}

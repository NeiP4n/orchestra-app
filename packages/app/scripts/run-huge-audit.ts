import { chromium, type Page } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const userDataDir = path.join(os.homedir(), ".orchestra", "browser-profile");
const reportsDir = path.join(process.cwd(), "reports");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const PROMPT = `Проведи глубокий и бескомпромиссный технический аудит открытого репозитория Orchestra: https://github.com/NeiP4n/orchestra-app (TypeScript, Effect v4, Bun, Windows/Linux/macOS). Это автономный терминальный AI-ассистент для команд разработки, TUI, веб-приложением и фоновым сервисом.

Проанализируй реальную кодовую базу и выяви все критические проблемы и архитектурные дефекты:
1. Архитектура Effect v4, многопоточность, гонки и сессии:
   - Управление фиберами в SessionRunCoordinator и SessionExecution (гонки при отмене/interrupt, потеря сигналов, подвисание dispatch lock).
   - Session Compaction: потеря контекста инструкций, рассинхронизация epoch baseline при параллельных сообщениях во время сжатия.
   - Дедлоки KeyedMutex и синхронизация очередей session_inbox.
2. Сетевой слой, фоновый сервис и стриминг:
   - Server-Sent Events (SSE) в packages/server: бэкпрешер, буферизация событий, риск OOM при быстрых LLM дельтах и медленных клиентах.
   - HTTP таймауты: брошенные сиротские проекты и несогласованные транзакции при обрыве соединения клиентом (POST /api/orchestra/society).
3. Платформенная безопасность Windows и Linux:
   - Защита путей (path traversal): обход песочницы через короткие имена DOS 8.3 (PROGRA~1, тильда ~), точки монтирования (junctions), различие регистра дисков.
   - Процессы и шелл на Windows: зависание дочерних процессов-зомби при process.kill() без дерева процессов, экранирование PowerShell аргументов.
4. Консистентность слоев и монорепозитория:
   - Инвариант зависимостей: Surface -> Transport -> Domain -> Client -> Contract -> Leaf. Нарушения границ слоев (утечки @orchestra/core в @orchestra/client или UI).
5. Поведение агентов и актуальность данных:
   - Защита от галлюцинаций устаревших версий библиотек (React 19, Effect v4, Bun 1.4, Vite 6, Tailwind v4).

Для каждой найденной проблемы укажи:
- Конкретные файлы и функции
- Сценарий сбоя или уязвимости
- Точный алгоритм или код решения.`;

console.log("=== ЗАПУСК ПАРАЛЛЕЛЬНОГО АУДИТА 4 ИИ ЧЕРЕЗ MICROSOFT EDGE ===");
console.log("Браузер: Microsoft Edge (channel: msedge)");
console.log("Постоянный профиль:", userDataDir);
console.log("Прокси:", "http://127.0.0.1:7897");

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "msedge",
  headless: false,
  proxy: { server: "http://127.0.0.1:7897" },
  viewport: { width: 1280, height: 850 }
});

async function safeFillAndSend(page: Page, selector: string, text: string) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 300000 });
  await page.waitForTimeout(1500);
  await locator.click();
  await locator.fill(text);
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
}

async function runChatGPT(page: Page) {
  try {
    console.log("[ChatGPT] Загрузка https://chatgpt.com/ ...");
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[ChatGPT] Ожидание поля ввода...");
    await safeFillAndSend(page, "#prompt-textarea, textarea", PROMPT);
    console.log("[ChatGPT] Промпт отправлен! Ожидание генерации...");
    
    await page.waitForTimeout(5000);
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(4000);
      const isStreaming = await page.$('button[aria-label*="Stop"], button[data-testid="stop-button"]');
      if (!isStreaming) {
        const text = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"], .markdown'));
          return els[els.length - 1]?.textContent || "";
        });
        if (text.length > 500) {
          console.log(`[ChatGPT] Генерация завершена! Получено ${text.length} символов.`);
          fs.writeFileSync(path.join(reportsDir, "audit-chatgpt.md"), text, "utf8");
          return text;
        }
      }
    }
  } catch (err: any) {
    console.error("[ChatGPT] Статус:", err.message);
  }
}

async function runDeepSeek(page: Page) {
  try {
    console.log("[DeepSeek] Загрузка https://chat.deepseek.com/ ...");
    await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[DeepSeek] Ожидание поля ввода (войдите в аккаунт при необходимости)...");
    await safeFillAndSend(page, "textarea#chat-input, textarea", PROMPT);
    console.log("[DeepSeek] Промпт отправлен! Ожидание ответа...");
    
    await page.waitForTimeout(5000);
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(4000);
      const isStreaming = await page.$('div[role="button"]:has-text("Stop"), .ds-icon--stop');
      if (!isStreaming) {
        const text = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.ds-markdown, .f9bf7997'));
          return els[els.length - 1]?.textContent || "";
        });
        if (text.length > 300) {
          console.log(`[DeepSeek] Генерация завершена! Получено ${text.length} символов.`);
          fs.writeFileSync(path.join(reportsDir, "audit-deepseek.md"), text, "utf8");
          return text;
        }
      }
    }
  } catch (err: any) {
    console.error("[DeepSeek] Статус:", err.message);
  }
}

async function runQwen(page: Page) {
  try {
    console.log("[Qwen] Загрузка https://chat.qwen.ai/ ...");
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[Qwen] Ожидание поля ввода (войдите в аккаунт при необходимости)...");
    await safeFillAndSend(page, "textarea, div[contenteditable=\"true\"]", PROMPT);
    console.log("[Qwen] Промпт отправлен! Ожидание ответа...");
    
    await page.waitForTimeout(5000);
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(4000);
      const text = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.message-content, .qwen-markdown, div[class*="message"]'));
        return els[els.length - 1]?.textContent || "";
      });
      if (text.length > 500) {
        console.log(`[Qwen] Ответ получен! Длина: ${text.length} символов.`);
        fs.writeFileSync(path.join(reportsDir, "audit-qwen.md"), text, "utf8");
        return text;
      }
    }
  } catch (err: any) {
    console.error("[Qwen] Статус:", err.message);
  }
}

async function runGemini(page: Page) {
  try {
    console.log("[Gemini] Загрузка https://gemini.google.com/app ...");
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[Gemini] Ожидание поля ввода (войдите в Google-аккаунт при необходимости)...");
    await safeFillAndSend(page, "rich-textarea p, div[contenteditable=\"true\"], textarea", PROMPT);
    console.log("[Gemini] Промпт отправлен! Ожидание ответа...");
    
    await page.waitForTimeout(5000);
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(4000);
      const text = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('model-response, .message-content, div.response-container'));
        return els[els.length - 1]?.textContent || "";
      });
      if (text.length > 500) {
        console.log(`[Gemini] Ответ получен! Длина: ${text.length} символов.`);
        fs.writeFileSync(path.join(reportsDir, "audit-gemini.md"), text, "utf8");
        return text;
      }
    }
  } catch (err: any) {
    console.error("[Gemini] Статус:", err.message);
  }
}

const pages = context.pages();
const p1 = pages[0] || (await context.newPage());
const p2 = await context.newPage();
const p3 = await context.newPage();
const p4 = await context.newPage();

console.log("Запускаем параллельную обработку всех 4 нейросетей в Microsoft Edge...");
await Promise.allSettled([
  runChatGPT(p1),
  runDeepSeek(p2),
  runQwen(p3),
  runGemini(p4)
]);

console.log("=== ВСЕ 4 ПОТОКА ЗАВЕРШЕНЫ ===");
console.log("Файлы отчётов сохранены в папке:", reportsDir);

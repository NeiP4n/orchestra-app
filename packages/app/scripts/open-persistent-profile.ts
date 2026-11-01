import { chromium } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";

const userDataDir = path.join(os.homedir(), ".orchestra", "browser-profile");
console.log("Opening persistent profile at:", userDataDir);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  proxy: { server: "http://127.0.0.1:7897" },
  viewport: { width: 1280, height: 850 }
});

const pages = context.pages();
const page1 = pages[0] || (await context.newPage());
await page1.goto("https://chatgpt.com/");

const page2 = await context.newPage();
await page2.goto("https://chat.deepseek.com/");

const page3 = await context.newPage();
await page3.goto("https://chat.qwen.ai/");

const page4 = await context.newPage();
await page4.goto("https://gemini.google.com/app");

console.log("-------------------------------------------------------------");
console.log("Persistent browser opened with all 4 AI tabs!");
console.log("Log in once. All cookies, tokens, and sessions are saved in:");
console.log(userDataDir);
console.log("They will NEVER be lost on restart or reboot.");
console.log("-------------------------------------------------------------");

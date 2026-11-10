// Manual integration proof: bun test/manual/browser-cdp-arguments.ts
// Uses only a fresh disposable profile and about:blank, never the operator profile.
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Cdp } from "../../src/browser/cdp.js"
import { BrowserPage } from "../../src/browser/page.js"
import { BrowserDevtools } from "../../src/browser/devtools.js"
const directory = await mkdtemp(path.join(tmpdir(), "orchestra-cdp-proof-"))
const child = spawn(
  "/usr/bin/google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${directory}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
)
let client: Cdp.Client | undefined
try {
  let port = ""
  for (let i = 0; i < 100; i++) {
    try {
      port = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]
      break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!port) throw Error("Chrome failed to start")
  const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  if (!Array.isArray(targets)) throw Error("Invalid Chrome target list")
  const pages = targets.map((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) throw Error("Invalid Chrome target")
    const type = "type" in raw && typeof raw.type === "string" ? raw.type : undefined
    const webSocketDebuggerUrl =
      "webSocketDebuggerUrl" in raw && typeof raw.webSocketDebuggerUrl === "string"
        ? raw.webSocketDebuggerUrl
        : undefined
    return { type, webSocketDebuggerUrl }
  })
  const socket = Cdp.pageSocketUrl(pages)
  if (!socket) throw Error("No page")
  client = await Cdp.connect((url) => new WebSocket(url) as unknown as Cdp.Socket, socket)
  await client.send("Runtime.evaluate", {
    expression: `document.body.innerHTML='<textarea id="field"></textarea><button id="go">Go</button>'; window.clicked=0; document.querySelector('#go').onclick=()=>window.clicked++`,
  })
  const hostile = `"'); globalThis.injected=true; //\n\u2028\u2029` + "\ud800"
  const typed: any = await Cdp.callPage(client, BrowserPage.typeExpression({ selector: "#field", text: hostile }))
  if (!typed.result?.value?.ok) throw Error("type failed")
  const checked: any = await client.send("Runtime.evaluate", {
    expression: '({value:document.querySelector("#field").value, injected:!!window.injected})',
    returnByValue: true,
  })
  if (checked.result.value.value !== hostile || checked.result.value.injected) throw Error("data changed or injected")
  const clickResult: any = await Cdp.callPage(client, BrowserPage.clickExpression({ selector: "#go" }))
  if (clickResult.result.value.text !== "Go") throw Error("Selector click changed label case")
  const clicked: any = await client.send("Runtime.evaluate", { expression: "window.clicked", returnByValue: true })
  if (clicked.result.value !== 1) throw Error("click failed")
  const missing: any = await Cdp.callPage(client, BrowserPage.clickExpression({ text: hostile }))
  if (missing.result.value.ok) throw Error("hostile text matched")
  const native: any = await Cdp.callPage(
    client,
    BrowserPage.typeExpression({ selector: "#field", text: hostile, native: true }),
  )
  if (!native.result.value.ok) throw Error("native focus failed")
  const evaluated: any = await Cdp.callPage(client, BrowserDevtools.evalExpression("Promise.resolve(21*2)"), true)
  if (evaluated.result.value.text !== "42") throw Error("eval promise failed")
  console.log(
    "LIVE_CDP_PASS isolated Chrome: exact hostile Unicode type, no injection, click, native focus, no-match, awaited eval=42",
  )
} finally {
  client?.close()
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(directory, { recursive: true, force: true })
}

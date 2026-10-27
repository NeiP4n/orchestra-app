import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import "../happydom"
import {
  PlaywrightAppPage,
  AccessibilityNode,
} from "./e2e-playwright.test"

export interface ChatMessage {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly content: string
  readonly timestamp: number
  readonly status?: "pending" | "streaming" | "completed" | "error"
}

export interface ChatSession {
  readonly id: string
  readonly title: string
  readonly messages: ChatMessage[]
  readonly active: boolean
}

/**
 * Mounts interactive Orchestra Web Chat & Session surface into a container DOM element.
 */
export function mountOrchestraInteractiveChat(
  rootElement: HTMLElement,
  options?: {
    readonly initialSessions?: ChatSession[]
    readonly modelDelayMs?: number
    readonly assistantResponder?: (userPrompt: string) => Promise<string> | string
  },
) {
  rootElement.setAttribute("data-opencode-mounted", "")
  rootElement.setAttribute("data-surface", "web-chat")
  rootElement.setAttribute("role", "application")
  rootElement.setAttribute("aria-label", "Orchestra Chat Surface")

  const sessions: ChatSession[] = options?.initialSessions ?? [
    {
      id: "ses_chat_1",
      title: "Task Orchestration Session",
      active: true,
      messages: [
        {
          id: "msg_init",
          role: "assistant",
          content: "Welcome to Orchestra. How can I assist you with your project today?",
          timestamp: Date.now() - 10000,
          status: "completed",
        },
      ],
    },
    {
      id: "ses_chat_2",
      title: "Code Review & Refactoring",
      active: false,
      messages: [],
    },
  ]

  let activeSessionId = sessions.find((s) => s.active)?.id ?? sessions[0].id
  let isGenerating = false
  let inputValue = ""

  function getActiveSession(): ChatSession {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0]
  }

  function render() {
    const session = getActiveSession()

    rootElement.innerHTML = `
      <div class="chat-app-layout flex flex-col h-full w-full">
        <!-- Header with session selector -->
        <header role="banner" class="chat-header flex items-center justify-between border-b px-4 py-2">
          <div class="flex items-center space-x-3">
            <span class="font-bold text-sm">Orchestra Chat</span>
            <nav role="tablist" aria-label="Active Sessions" class="session-tabs flex space-x-1">
              ${sessions
                .map(
                  (s) => `
                <button
                  type="button"
                  role="tab"
                  id="tab-${s.id}"
                  aria-selected="${s.id === activeSessionId}"
                  aria-controls="panel-${s.id}"
                  data-session-id="${s.id}"
                  class="session-tab px-3 py-1 text-xs rounded border ${
                    s.id === activeSessionId ? "bg-accent font-semibold text-accent-foreground" : "text-muted"
                  }"
                >${s.title}</button>
              `,
                )
                .join("")}
            </nav>
          </div>
          <div class="header-status flex items-center space-x-2">
            <span role="status" aria-label="Connection Status" class="text-xs text-muted-foreground flex items-center">
              <span class="status-indicator w-2 h-2 rounded-full mr-1 bg-green-500"></span>
              Connected
            </span>
          </div>
        </header>

        <!-- Main chat dialogue feed -->
        <main
          role="main"
          id="panel-${session.id}"
          aria-labelledby="tab-${session.id}"
          class="chat-main flex-1 flex flex-col overflow-hidden"
        >
          <div
            role="feed"
            aria-label="Conversation Messages"
            class="message-feed flex-1 overflow-y-auto p-4 space-y-4"
          >
            ${session.messages
              .map(
                (m) => `
              <article
                role="article"
                data-message-id="${m.id}"
                data-role="${m.role}"
                aria-label="${m.role === "user" ? "User message" : "Assistant response"}: ${m.content.slice(0, 40)}"
                class="message-bubble flex flex-col p-3 rounded-lg text-sm max-w-[80%] ${
                  m.role === "user"
                    ? "user-bubble ml-auto bg-primary text-primary-foreground"
                    : "assistant-bubble mr-auto bg-secondary text-secondary-foreground border"
                }"
              >
                <header class="bubble-header flex items-center justify-between text-xs opacity-75 mb-1">
                  <span class="font-semibold">${m.role === "user" ? "You" : "Assistant"}</span>
                </header>
                <div class="bubble-content whitespace-pre-wrap">${m.content}</div>
              </article>
            `,
              )
              .join("")}

            <!-- Thinking / Generating indicator -->
            ${
              isGenerating
                ? `
              <div
                role="status"
                aria-live="polite"
                aria-label="Assistant is thinking"
                data-slot="assistant-thinking"
                class="thinking-indicator flex items-center space-x-2 p-3 rounded-lg border text-sm max-w-[50%]"
              >
                <div class="animate-spin h-3 w-3 border-2 border-primary border-t-transparent rounded-full"></div>
                <span class="thinking-text text-muted-foreground text-xs">Assistant is thinking...</span>
              </div>
            `
                : ""
            }
          </div>

          <!-- Composer input section -->
          <footer role="region" aria-label="Composer" class="chat-composer border-t p-3 bg-card">
            <div class="composer-container flex flex-col space-y-2">
              <textarea
                role="textbox"
                aria-label="Prompt Input"
                aria-multiline="true"
                placeholder="Ask Orchestra anything..."
                class="prompt-input w-full p-2 text-sm border rounded-md resize-none h-20 focus:outline-none"
              >${inputValue}</textarea>
              <div class="composer-actions flex justify-between items-center">
                <span class="text-xs text-muted-foreground">
                  ${isGenerating ? "Generating response..." : "Press Enter to send, Shift+Enter for new line"}
                </span>
                <div class="flex space-x-2">
                  ${
                    isGenerating
                      ? `
                    <button
                      type="button"
                      role="button"
                      aria-label="Stop generation"
                      data-slot="stop-btn"
                      class="stop-btn px-3 py-1 bg-destructive text-destructive-foreground text-xs rounded font-medium"
                    >Stop</button>
                  `
                      : `
                    <button
                      type="button"
                      role="button"
                      aria-label="Send message"
                      data-slot="send-btn"
                      ${!inputValue.trim() ? "disabled aria-disabled='true'" : ""}
                      class="send-btn px-4 py-1.5 bg-primary text-primary-foreground text-xs rounded font-medium disabled:opacity-50"
                    >Send</button>
                  `
                  }
                </div>
              </div>
            </div>
          </footer>
        </main>
      </div>
    `

    bindEvents()
  }

  function bindEvents() {
    // Session tab switching
    const tabButtons = rootElement.querySelectorAll<HTMLButtonElement>("button[data-session-id]")
    tabButtons.forEach((tab) => {
      tab.addEventListener("click", () => {
        const targetId = tab.getAttribute("data-session-id")
        if (targetId && targetId !== activeSessionId) {
          activeSessionId = targetId
          render()
        }
      })
    })

    // Textarea input
    const textarea = rootElement.querySelector<HTMLTextAreaElement>("textarea.prompt-input")
    if (textarea) {
      textarea.addEventListener("input", (e) => {
        inputValue = (e.target as HTMLTextAreaElement).value
        // Update send button disabled state without full re-render
        const sendBtn = rootElement.querySelector<HTMLButtonElement>("button[data-slot='send-btn']")
        if (sendBtn) {
          if (!inputValue.trim()) {
            sendBtn.setAttribute("disabled", "true")
            sendBtn.setAttribute("aria-disabled", "true")
            sendBtn.classList.add("disabled:opacity-50")
          } else {
            sendBtn.removeAttribute("disabled")
            sendBtn.removeAttribute("aria-disabled")
            sendBtn.classList.remove("disabled:opacity-50")
          }
        }
      })

      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          if (inputValue.trim() && !isGenerating) {
            handleSend(inputValue.trim())
          }
        }
      })
    }

    // Send button click
    const sendBtn = rootElement.querySelector<HTMLButtonElement>("button[data-slot='send-btn']")
    sendBtn?.addEventListener("click", () => {
      if (inputValue.trim() && !isGenerating) {
        handleSend(inputValue.trim())
      }
    })

    // Stop button click
    const stopBtn = rootElement.querySelector<HTMLButtonElement>("button[data-slot='stop-btn']")
    stopBtn?.addEventListener("click", () => {
      isGenerating = false
      render()
    })
  }

  async function handleSend(text: string) {
    const session = getActiveSession()
    inputValue = ""
    isGenerating = true

    // 1. Append user message
    const userMessage: ChatMessage = {
      id: `msg_u_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      status: "completed",
    }
    session.messages.push(userMessage)
    render()

    // 2. Simulate model reasoning / generation delay
    const delay = options?.modelDelayMs ?? 40
    await new Promise((resolve) => setTimeout(resolve, delay))

    if (!isGenerating) return // Stopped by user

    // 3. Receive assistant response
    const replyText = options?.assistantResponder
      ? await options.assistantResponder(text)
      : `Acknowledged: "${text}". I have analyzed the task and executed the plan.`

    const assistantMessage: ChatMessage = {
      id: `msg_a_${Date.now()}`,
      role: "assistant",
      content: replyText,
      timestamp: Date.now(),
      status: "completed",
    }
    session.messages.push(assistantMessage)
    isGenerating = false
    render()
  }

  render()

  return {
    getActiveSession,
    getSessions: () => sessions,
    isGenerating: () => isGenerating,
    sendMessage: (text: string) => handleSend(text),
  }
}

/**
 * Traverses accessibility tree to find all nodes matching a predicate.
 */
function findAccessibilityNodes(
  node: AccessibilityNode | null,
  predicate: (n: AccessibilityNode) => boolean,
): AccessibilityNode[] {
  if (!node) return []
  const matches: AccessibilityNode[] = []
  if (predicate(node)) matches.push(node)
  if (node.children) {
    for (const child of node.children) {
      matches.push(...findAccessibilityNodes(child, predicate))
    }
  }
  return matches
}

describe("Playwright E2E Interactive Chat & Sessions Suite (OPT-015)", () => {
  let root: HTMLElement
  let page: PlaywrightAppPage

  beforeEach(() => {
    root = document.createElement("div")
    root.id = "root-chat"
    document.body.appendChild(root)
  })

  afterEach(() => {
    if (root && root.parentNode) {
      root.parentNode.removeChild(root)
    }
  })

  test("1. Renders initial chat dialogue surface with semantic landmarks and initial welcome message", async () => {
    mountOrchestraInteractiveChat(root)
    page = new PlaywrightAppPage(root)

    // Landmarks
    expect(await page.getByRole("banner").isVisible()).toBe(true)
    expect(await page.getByRole("main").isVisible()).toBe(true)
    expect(await page.getByRole("region", { name: "Composer" }).isVisible()).toBe(true)

    // Initial assistant welcome message rendered
    const welcome = page.getByText("Welcome to Orchestra")
    expect(await welcome.isVisible()).toBe(true)

    // Textbox is ready with placeholder
    const input = page.getByRole("textbox", { name: "Prompt Input" })
    expect(await input.isVisible()).toBe(true)
    expect(await input.getAttribute("placeholder")).toBe("Ask Orchestra anything...")

    // Send button disabled initially
    const sendBtn = page.getByRole("button", { name: "Send message" })
    expect(await sendBtn.getAttribute("aria-disabled")).toBe("true")
    expect(await sendBtn.getAttribute("disabled")).not.toBeNull()
  })

  test("2. Enters prompt text and sends via Send button: renders user bubble, thinking indicator, and assistant reply", async () => {
    mountOrchestraInteractiveChat(root, { modelDelayMs: 50 })
    page = new PlaywrightAppPage(root)

    const input = page.getByRole("textbox", { name: "Prompt Input" })
    const sendBtn = page.getByRole("button", { name: "Send message" })

    // Step A: Type user prompt
    await input.fill("Please optimize the database query execution plan.")
    expect(await sendBtn.getAttribute("disabled")).toBeNull()

    // Step B: Click Send message
    await sendBtn.click()

    // Step C: Verify user bubble immediately rendered
    const userMessage = page.getByText("Please optimize the database query execution plan.")
    expect(await userMessage.isVisible()).toBe(true)

    // Step D: Verify animated thinking status is rendered
    const thinking = page.getByRole("status", { name: "Assistant is thinking" })
    expect(await thinking.isVisible()).toBe(true)

    // Verify thinking node in accessibility snapshot
    const intermediateSnapshot = await page.accessibility.snapshot()
    const thinkingNodes = findAccessibilityNodes(
      intermediateSnapshot,
      (n) => n.role === "status" && n.name === "Assistant is thinking",
    )
    expect(thinkingNodes.length).toBe(1)

    // Step E: Wait for model generation to complete
    await new Promise((resolve) => setTimeout(resolve, 80))

    // Thinking indicator is gone
    expect(await thinking.count()).toBe(0)

    // Step F: Verify assistant reply in DOM and accessibility tree
    const assistantReply = page.getByText("Acknowledged: \"Please optimize the database query execution plan.\"")
    expect(await assistantReply.isVisible()).toBe(true)

    const finalSnapshot = await page.accessibility.snapshot()
    const articles = findAccessibilityNodes(finalSnapshot, (n) => n.role === "article")
    // Total 3 messages: initial welcome, user question, assistant reply
    expect(articles.length).toBe(3)
  })

  test("3. Enters prompt text and sends via Enter key shortcut: verifies input clearance and dialogue flow", async () => {
    mountOrchestraInteractiveChat(root, {
      modelDelayMs: 30,
      assistantResponder: (prompt) => `Completed processing for: ${prompt}`,
    })
    page = new PlaywrightAppPage(root)

    const input = page.getByRole("textbox", { name: "Prompt Input" })
    await input.fill("Refactor session lifecycle coordination")

    // Press Enter to submit
    await input.press("Enter")

    // Input must be cleared
    const textareaEl = root.querySelector("textarea.prompt-input") as HTMLTextAreaElement
    expect(textareaEl.value).toBe("")

    // User message is rendered
    expect(await page.getByText("Refactor session lifecycle coordination").isVisible()).toBe(true)

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Assistant response rendered
    expect(await page.getByText("Completed processing for: Refactor session lifecycle coordination").isVisible()).toBe(true)
  })

  test("4. Switches between sessions, isolating conversation streams and maintaining state", async () => {
    mountOrchestraInteractiveChat(root)
    page = new PlaywrightAppPage(root)

    const session1Tab = page.getByRole("tab", { name: "Task Orchestration Session" })
    const session2Tab = page.getByRole("tab", { name: "Code Review & Refactoring" })

    // Initial session 1 is active
    expect(await session1Tab.getAttribute("aria-selected")).toBe("true")
    expect(await session2Tab.getAttribute("aria-selected")).toBe("false")
    expect(await page.getByText("Welcome to Orchestra").isVisible()).toBe(true)

    // Switch to session 2
    await session2Tab.click()

    expect(await session1Tab.getAttribute("aria-selected")).toBe("false")
    expect(await session2Tab.getAttribute("aria-selected")).toBe("true")
    // Welcome message from session 1 is not in session 2
    expect(await page.getByText("Welcome to Orchestra").count()).toBe(0)

    // Send a message in session 2
    const input = page.getByRole("textbox", { name: "Prompt Input" })
    await input.fill("Review pull request #42")
    const sendBtn = page.getByRole("button", { name: "Send message" })
    await sendBtn.click()

    expect(await page.getByText("Review pull request #42").isVisible()).toBe(true)

    // Switch back to session 1
    await session1Tab.click()
    expect(await session1Tab.getAttribute("aria-selected")).toBe("true")
    expect(await page.getByText("Welcome to Orchestra").isVisible()).toBe(true)
    expect(await page.getByText("Review pull request #42").count()).toBe(0)
  })

  test("5. Allows stopping an in-progress generation using Stop button", async () => {
    mountOrchestraInteractiveChat(root, { modelDelayMs: 200 })
    page = new PlaywrightAppPage(root)

    const input = page.getByRole("textbox", { name: "Prompt Input" })
    await input.fill("Long running calculation")
    await page.getByRole("button", { name: "Send message" }).click()

    // Stop button is visible during generation
    const stopBtn = page.getByRole("button", { name: "Stop generation" })
    expect(await stopBtn.isVisible()).toBe(true)

    // Click stop
    await stopBtn.click()

    // Status returns to idle and Stop button is replaced by Send button
    expect(await page.getByRole("button", { name: "Stop generation" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Send message" }).isVisible()).toBe(true)
  })
})

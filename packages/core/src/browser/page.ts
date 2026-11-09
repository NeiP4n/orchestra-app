export * as BrowserPage from "./page.js"

// Small scripts the chat agent runs inside the page. Arguments are always passed through JSON.stringify so
// a selector or text can never break out of the script.

// Where the element is, as a fraction of the whole window (page plus the browser's own top bar), so the pane can
// show the agent's cursor there whatever the zoom or the pane size.
const AT = `(() => { const r = el.getBoundingClientRect(); const w = window.outerWidth || window.innerWidth; const h = window.outerHeight || window.innerHeight; return { x: (r.left + r.width / 2) / w, y: (h - window.innerHeight + r.top + r.height / 2) / h } })()`

const clickable = `'a,button,input[type=button],input[type=submit],[role=button],[role=link],summary,label'`

/** Clicks the first element matching a CSS selector, or the first clickable one whose text contains `text`. */
export function clickExpression(target: { selector?: string; text?: string; native?: boolean }) {
  const act = target.native ? "" : "el.click(); "
  const rect = "rect: (() => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })(), "
  if (target.selector !== undefined)
    return `(() => { const el = document.querySelector(${JSON.stringify(target.selector)}); if (!el) return { ok: false, error: 'No element matches the selector.' }; el.scrollIntoView({ block: 'center' }); ${act}return { ok: true, ${rect}at: ${AT}, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 80) } })()`
  if (target.text !== undefined)
    return `(() => { const want = ${JSON.stringify(target.text.toLowerCase())}; const list = [...document.querySelectorAll(${clickable})]; const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase(); const el = list.find((item) => label(item) === want) || list.find((item) => label(item).includes(want)); if (!el) return { ok: false, error: 'No clickable element has that text.' }; el.scrollIntoView({ block: 'center' }); ${act}return { ok: true, ${rect}at: ${AT}, tag: el.tagName.toLowerCase(), text: label(el).slice(0, 80) } })()`
  throw new Error("click needs a selector or a text.")
}

/** Focuses a field, replaces its value the way a user typing would, and fires input and change. */
export function typeExpression(input: { selector: string; text: string; native?: boolean }) {
  // native: only focus and select what is there; the caller sends the text as real keyboard input (Input.insertText).
  if (input.native)
    return `(() => { const el = document.querySelector(${JSON.stringify(input.selector)}); if (!el) return { ok: false, error: 'No element matches the selector.' }; el.scrollIntoView({ block: 'center' }); el.focus(); if (el.isContentEditable) { document.getSelection()?.selectAllChildren(el) } else if (typeof el.select === 'function') { el.select() } return { ok: true, at: ${AT}, tag: el.tagName.toLowerCase() } })()`
  return `(() => { const el = document.querySelector(${JSON.stringify(input.selector)}); if (!el) return { ok: false, error: 'No element matches the selector.' }; el.scrollIntoView({ block: 'center' }); el.focus(); if (el.isContentEditable) { el.textContent = ${JSON.stringify(input.text)} } else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (set) set.call(el, ${JSON.stringify(input.text)}); else el.value = ${JSON.stringify(input.text)} } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, at: ${AT}, tag: el.tagName.toLowerCase() } })()`
}

export interface Outcome {
  ok: boolean
  error?: string
  tag?: string
  at?: { x: number; y: number }
  text?: string
}

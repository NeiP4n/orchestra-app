export * as BrowserPage from "./page.js"

// Small scripts the chat agent runs inside the page. Arguments are always passed through JSON.stringify so
// a selector or text can never break out of the script.

const clickable = `'a,button,input[type=button],input[type=submit],[role=button],[role=link],summary,label'`

/** Clicks the first element matching a CSS selector, or the first clickable one whose text contains `text`. */
export function clickExpression(target: { selector?: string; text?: string }) {
  if (target.selector !== undefined)
    return `(() => { const el = document.querySelector(${JSON.stringify(target.selector)}); if (!el) return { ok: false, error: 'No element matches the selector.' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 80) } })()`
  if (target.text !== undefined)
    return `(() => { const want = ${JSON.stringify(target.text.toLowerCase())}; const list = [...document.querySelectorAll(${clickable})]; const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase(); const el = list.find((item) => label(item) === want) || list.find((item) => label(item).includes(want)); if (!el) return { ok: false, error: 'No clickable element has that text.' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true, tag: el.tagName.toLowerCase(), text: label(el).slice(0, 80) } })()`
  throw new Error("click needs a selector or a text.")
}

/** Focuses a field, replaces its value the way a user typing would, and fires input and change. */
export function typeExpression(input: { selector: string; text: string }) {
  return `(() => { const el = document.querySelector(${JSON.stringify(input.selector)}); if (!el) return { ok: false, error: 'No element matches the selector.' }; el.scrollIntoView({ block: 'center' }); el.focus(); if (el.isContentEditable) { el.textContent = ${JSON.stringify(input.text)} } else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (set) set.call(el, ${JSON.stringify(input.text)}); else el.value = ${JSON.stringify(input.text)} } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, tag: el.tagName.toLowerCase() } })()`
}

export interface Outcome {
  ok: boolean
  error?: string
  tag?: string
  text?: string
}

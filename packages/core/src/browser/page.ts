export * as BrowserPage from "./page.js"

// Page input travels as CDP arguments, never as executable source.
import type { Cdp } from "./cdp.js"

// Where the element is, as a fraction of the whole window (page plus the browser's own top bar), so the pane can
// show the agent's cursor there whatever the zoom or the pane size.
const AT = `(() => { const r = el.getBoundingClientRect(); const w = window.outerWidth || window.innerWidth; const h = window.outerHeight || window.innerHeight; return { x: (r.left + r.width / 2) / w, y: (h - window.innerHeight + r.top + r.height / 2) / h } })()`

const clickable = `'a,button,input[type=button],input[type=submit],[role=button],[role=link],summary,label'`

/** Clicks the first element matching a CSS selector, or the first clickable one whose text contains `text`. */
export function clickExpression(target: { selector?: string; text?: string; native?: boolean }): Cdp.PageCall {
  if (target.selector === undefined && target.text === undefined) throw new Error("click needs a selector or a text.")
  return {
    functionDeclaration: `function(target) {
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      const want = (target.text || '').toLowerCase();
      const list = target.selector === undefined ? [...document.querySelectorAll(${clickable})] : [];
      const el = target.selector !== undefined ? document.querySelector(target.selector) : list.find(item => label(item) === want) || list.find(item => label(item).includes(want));
      if (!el) return { ok: false, error: target.selector !== undefined ? 'No element matches the selector.' : 'No clickable element has that text.' };
      el.scrollIntoView({ block: 'center' });
      if (!target.native) el.click();
      return { ok: true, rect: (() => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })(), at: ${AT}, tag: el.tagName.toLowerCase(), text: target.selector !== undefined ? (el.innerText || el.value || '').trim().slice(0,80) : label(el).slice(0,80) };
    }`,
    arguments: [{ value: target }],
  }
}

/** Focuses a field, replaces its value the way a user typing would, and fires input and change. */
export function typeExpression(input: { selector: string; text: string; native?: boolean }): Cdp.PageCall {
  return {
    functionDeclaration: `function(input) {
      const el = document.querySelector(input.selector);
      if (!el) return { ok: false, error: 'No element matches the selector.' };
      el.scrollIntoView({ block: 'center' }); el.focus();
      if (input.native) {
        if (el.isContentEditable) document.getSelection()?.selectAllChildren(el);
        else if (typeof el.select === 'function') el.select();
      } else {
        if (el.isContentEditable) el.textContent = input.text;
        else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (set) set.call(el, input.text); else el.value = input.text; }
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, at: ${AT}, tag: el.tagName.toLowerCase() };
    }`,
    arguments: [{ value: input }],
  }
}

export interface Outcome {
  ok: boolean
  error?: string
  tag?: string
  at?: { x: number; y: number }
  text?: string
}

const REF = /^@?e(\d{1,5})$/

/** The CSS selector of an element numbered by the last snapshot: "e3" or "@e3". Anything else is refused. */
export function refSelector(ref: string) {
  const match = REF.exec(ref.trim())
  if (!match) throw new Error(`"${ref}" is not a ref. Refs look like @e3 and come from action=snapshot.`)
  return `[data-orc-ref="e${match[1]}"]`
}

export const STALE_REF = "That ref is gone: the page changed since the snapshot. Take a new snapshot and use its refs."

/**
 * Numbers every visible, interactive element of the page (links, buttons, fields, menus, tabs) and returns them as
 * one line each: `@e3 button "Sign in"`. The number is written onto the element itself (data-orc-ref), so click and
 * type can find it again; a page that reloads or rebuilds the element loses the number, which the agent sees as a
 * stale ref and answers with a new snapshot. Refs of an older snapshot are cleared first.
 */
export function snapshotExpression(limit = 250) {
  return `(() => {
    for (const old of document.querySelectorAll('[data-orc-ref]')) old.removeAttribute('data-orc-ref')
    const pick = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick]'
    const seen = new Set()
    const lines = []
    let total = 0
    for (const el of document.querySelectorAll(pick)) {
      if (seen.has(el)) continue
      seen.add(el)
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (box.width < 1 || box.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue
      total++
      if (lines.length >= ${limit}) continue
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag === 'textarea' ? 'textbox' : tag)
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
      const ref = 'e' + (lines.length + 1)
      el.setAttribute('data-orc-ref', ref)
      const extra = []
      if (el.disabled) extra.push('disabled')
      if (el.checked) extra.push('checked')
      if (tag === 'a' && el.getAttribute('href')) extra.push('href=' + el.getAttribute('href').slice(0, 80))
      if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value && label !== el.value) extra.push('value=' + JSON.stringify(String(el.value).slice(0, 40)))
      lines.push('@' + ref + ' ' + role + (label ? ' ' + JSON.stringify(label) : '') + (extra.length ? ' ' + extra.join(' ') : ''))
    }
    return { ok: true, text: lines.join('\\n') + (total > lines.length ? '\\n[' + (total - lines.length) + ' more elements not listed: scroll or use text]' : '') }
  })()`
}

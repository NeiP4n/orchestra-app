// Tiny deterministic DOM fixture for the watcher script. Implements the DOM
// operations that script uses, not WhatsApp's current live DOM.
export class RowElement {
  parent: RowElement | undefined
  children: RowElement[] = []
  constructor(readonly attrs: Record<string, string> = {}, readonly innerText = "fixture message", readonly tag = "div") {}
  get textContent() { return this.innerText }
  getAttribute(name: string) { return this.attrs[name] ?? null }
  append(child: RowElement) { child.parent = this; this.children.push(child); return child }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      if (part.startsWith(".")) return (this.attrs.class ?? "").split(/\s+/).includes(part.slice(1))
      const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part)
      if (attr) return attr[2] === undefined ? attr[1]! in this.attrs : this.attrs[attr[1]!] === attr[2]
      return this.tag === part
    })
  }
  closest(selector: string): RowElement | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  querySelectorAll(selector: string): RowElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}

export const directionRows = () => {
  const incoming = new RowElement({ "data-id": "false_fixture" }, "in by id")
  const outgoing = new RowElement({ "data-id": "true_fixture" }, "out by id")
  const unknown = new RowElement({ "data-id": "opaque" }, "unknown direction")
  const iconOnly = new RowElement({ "data-id": "opaque-check" }, "out icon only")
  iconOnly.append(new RowElement({ "data-icon": "msg-dblcheck" }))
  const parent = new RowElement({ class: "message-in" })
  const inherited = parent.append(new RowElement({ "data-id": "opaque-in" }, "in by parent"))
  const conflict = new RowElement({ "data-id": "false_conflict", class: "message-out" }, "conflict")
  const descendantConflict = new RowElement({ "data-id": "false_child" }, "out by child")
  descendantConflict.append(new RowElement({ "data-direction": "out" }))
  const attrIn = new RowElement({ "data-id": "opaque-attr", "data-outgoing": "false" }, "in by attribute")
  const attrOut = new RowElement({ "data-id": "false_attr", "data-outgoing": "true" }, "out by attribute")
  const directionIn = new RowElement({ "data-id": "opaque-direction", "data-direction": "in" }, "in by direction")
  return [incoming, outgoing, unknown, iconOnly, inherited, conflict, descendantConflict, attrIn, attrOut, directionIn]
}

// Structural shape from the live sample. IDs/text are invented, not message data.
export const liveShapeRows = () => {
  const make = (id: string, tail?: string) => {
    const row = new RowElement({ "data-id": id })
    const container = row.append(new RowElement({ "data-testid": "msg-container" }))
    if (tail) container.append(new RowElement({ "data-testid": tail, "data-icon": tail }))
    container.append(new RowElement({ "data-testid": "selectable-text" }))
    container.append(new RowElement({ "data-testid": "msg-meta" }))
    return row
  }
  return [make("opaque-out", "tail-out"), make("opaque-in", "tail-in"), make("opaque-no-tail")]
}

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GUIDE, KINDS, parse, type Segment, type Widget } from "../src/widgets/parse"
import { activate, browsable, needsAnswer, pending, press, reply, type Key, type Outcome } from "../src/widgets/press"
import { clip, render, wrap, type Focus } from "../src/widgets/render"
import { afterAll, beforeAll } from "bun:test"
import { setActiveLanguage } from "../src/util/i18n"

// These modules draw their texts through the active language; the expectations below are Russian.
beforeAll(() => setActiveLanguage("ru"))
afterAll(() => setActiveLanguage("en"))

function widget(source: string): Widget {
  const found = parse(source).find((segment): segment is Extract<Segment, { type: "widget" }> => segment.type === "widget")
  if (!found) throw new Error(`no widget in ${source}`)
  return found.widget
}

// Presses keys in order and returns the final element with the last outcome.
function keys(start: Widget, ...sequence: Key[]): { widget: Widget; outcome: Outcome } {
  let current = start
  let outcome: Outcome = { type: "none" }
  for (const key of sequence) ({ widget: current, outcome } = press(current, key))
  return { widget: current, outcome }
}

const text = (w: Widget, focus: Focus = "active", width = 60) =>
  render(w, width, focus)
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n")

describe("parsing", () => {
  test("text around blocks is kept and code fences around them are dropped", () => {
    const segments = parse("Выберите:\n```\n@ui choice Тест\n- а\n- б\n@end\n```\nПосле.")
    expect(segments.map((segment) => segment.type)).toEqual(["text", "widget", "text"])
    expect(segments[0]).toEqual({ type: "text", text: "Выберите:" })
    expect(segments[2]).toEqual({ type: "text", text: "После." })
  })

  test("unknown or empty blocks stay plain text and a missing @end still parses", () => {
    expect(parse("@ui hologram x\n- a\n@end").map((s) => s.type)).toEqual(["text"])
    expect(parse("@ui choice\n@end").map((s) => s.type)).toEqual(["text"])
    expect(parse("@ui choice Q\n- a\n- b").map((s) => s.type)).toEqual(["widget"])
    expect(parse("just text, @ui inside a sentence").map((s) => s.type)).toEqual(["text"])
  })

  test("a message without blocks is a single text segment", () => {
    expect(parse("обычный ответ\nв две строки")).toEqual([{ type: "text", text: "обычный ответ\nв две строки" }])
  })
})

describe("interaction", () => {
  test("a long choice description is wrapped under its option instead of clipped", () => {
    const hint = "Визуальный интерфейс на OpenTUI для управления агентами, сессиями и задачами в одном окне"
    const w = widget(`@ui choice Выберите направление
- Интерактивный TUI-дашборд управления (Recommended) | ${hint}
- Короткий | да
@end`)
    const text = render(w, 60, "active").map((line) => line.map((part) => part.text).join(""))
    expect(text.some((line) => line.includes("…"))).toBe(false)
    // Every word of the description is still on screen, only moved to following lines.
    expect(text.join(" ").replace(/[│╭╰]/g, "").replace(/\s+/g, " ")).toContain(hint)
    // A short hint keeps its place beside the label.
    expect(text.some((line) => line.includes("Короткий") && line.includes("да"))).toBe(true)
  })

  test("choice moves, wraps and answers by Enter or digit", () => {
    const w = widget("@ui choice Что?\n- один | первый\n- два\n- три\n@end")
    const result = keys(w, "up", "enter")
    expect(result.outcome).toEqual({ type: "answer", value: "три" })
    expect(result.widget.answered).toBe("три")
    expect(reply(w, "три")).toBe("Ответ на «Что?»: три")
    expect(keys(widget("@ui choice\n- a\n- b\n@end"), "2").outcome).toEqual({ type: "answer", value: "b" })
    expect(reply(widget("@ui choice\n- a\n@end"), "a")).toBe("Ответ: a")
  })

  test("multi toggles, selects all and reports nothing when empty", () => {
    const w = widget("@ui multi Что включить\n- [x] А\n- [ ] Б\n- [ ] В\n@end")
    expect(keys(w, "down", " ", "enter").outcome).toEqual({ type: "answer", value: "А, Б" })
    expect(keys(widget("@ui multi\n- a\n- b\n@end"), "a", "a", "enter").outcome).toEqual({ type: "answer", value: "ничего" })
  })

  test("confirm, buttons and input answer as expected", () => {
    expect(keys(widget("@ui confirm Удалить?\nЭто необратимо\nyes: Удалить\nno: Оставить\n@end"), "n").outcome).toEqual({ type: "answer", value: "Оставить" })
    expect(keys(widget("@ui buttons\n- Старт\n- Стоп\n@end"), "right", "enter").outcome).toEqual({ type: "answer", value: "Стоп" })
    expect(keys(widget("@ui input Имя\ndefault: Ив\n@end"), "а", "н", "enter").outcome).toEqual({ type: "answer", value: "Иван" })
    expect(keys(widget("@ui input\n@end"), "enter").outcome).toEqual({ type: "none" })
  })

  test("form edits every field type and submits from the last row", () => {
    const w = widget("@ui form Профиль\n- Имя: text Аня\n- Возраст: number 3\n- Согласна: bool no\n- Уровень: select новичок, эксперт\n@end")
    const result = keys(w, "!", "down", "x", "1", "down", " ", "down", "right", "down", "enter")
    expect(result.outcome).toEqual({ type: "answer", value: "Имя=Аня!; Возраст=31; Согласна=да; Уровень=эксперт" })
  })

  test("scale stays in range and stars read naturally", () => {
    expect(keys(widget("@ui scale Оценка\nrange: 1-5\ndefault: 4\nstyle: stars\n@end"), "right", "right", "enter").outcome).toEqual({ type: "answer", value: "5 из 5" })
    expect(keys(widget("@ui scale\nrange: 0-10\n@end"), "3", "enter").outcome).toEqual({ type: "answer", value: "3" })
  })

  test("tables only ask for an answer when selectable", () => {
    expect(needsAnswer(widget("@ui table\ncols: a | b\n- 1 | 2\n@end"))).toBe(false)
    const pick = widget("@ui table Строка\ncols: имя | цена\n- чай | 10\n- кофе | 20\nselect: true\n@end")
    expect(needsAnswer(pick)).toBe(true)
    expect(keys(pick, "down", "enter").outcome).toEqual({ type: "answer", value: "кофе | 20" })
  })

  test("diff, rank, tree and run answer with their own vocabulary", () => {
    expect(keys(widget("@ui diff Правка\n--- a\n+++ b\n-старое\n+новое\nactions: Применить | Отклонить\n@end"), "right", "enter").outcome).toEqual({ type: "answer", value: "Отклонить" })
    expect(keys(widget("@ui rank Приоритет\n- тесты\n- дизайн\n- релиз\n@end"), "down", "down", "up", "enter").outcome).toEqual({ type: "answer", value: "дизайн > тесты > релиз" })
    expect(keys(widget("@ui tree Файл\n- src\n  - main.rs\n  - lib.rs\n- docs\nselect: true\n@end"), "down", "down", "enter").outcome).toEqual({ type: "answer", value: "src/lib.rs" })
    const run = widget("@ui run Что запустить\n- Тесты | cargo test\n- Сборка | cargo build\n@end")
    expect(keys(run, "c").outcome).toEqual({ type: "copy", text: "cargo test" })
    expect(keys(run, "enter").outcome).toEqual({ type: "answer", value: "выполни `cargo test`" })
  })

  test("read-only elements never demand an answer", () => {
    for (const source of [
      "@ui progress\n- Сборка: 50%\n@end",
      "@ui steps\n- [x] a\n- [~] b\n@end",
      "@ui code rust\nfn main() {}\n@end",
      "@ui kv\n- ключ: значение\n@end",
      "@ui callout warn\nОсторожно\n@end",
      "@ui tabs\n# Один\nтекст\n# Два\nещё\n@end",
      "@ui spark Нагрузка\nvalues: 1 4 2 8\n@end",
      "@ui timeline\n- 10:00 | старт\n- 10:05 | конец\n@end",
    ])
      expect(needsAnswer(widget(source))).toBe(false)
  })

  test("tabs switch pages and code copies itself", () => {
    const tabs = widget("@ui tabs\n# Один\nпервая\n# Два\nвторая\n@end")
    expect(browsable(tabs)).toBe(true)
    expect(text(tabs)).toContain("первая")
    expect(text(keys(tabs, "right").widget)).toContain("вторая")
    expect(keys(widget("@ui code rust\nlet x = 1;\nlet y = 2;\n@end"), "c").outcome).toEqual({ type: "copy", text: "let x = 1;\nlet y = 2;" })
  })

  test("Esc hands the keyboard back and an answered element is no longer pending", () => {
    const w = widget("@ui choice\n- a\n@end")
    expect(press(w, "esc").outcome).toEqual({ type: "release" })
    expect(pending(w)).toBe(true)
    expect(pending(keys(w, "enter").widget)).toBe(false)
  })
})

describe("clicks", () => {
  test("a click on a choice, button or diff action answers at once", () => {
    expect(activate(widget("@ui choice\n- a\n- b\n@end"), 1).outcome).toEqual({ type: "answer", value: "b" })
    expect(activate(widget("@ui buttons\n- X\n- Y\n@end"), 0).outcome).toEqual({ type: "answer", value: "X" })
    expect(activate(widget("@ui diff\n+a\n@end"), 1).outcome).toEqual({ type: "answer", value: "Отклонить" })
    expect(activate(widget("@ui confirm\n@end"), 1).outcome).toEqual({ type: "answer", value: "Нет" })
  })

  test("a click toggles multi items, changes form toggles and submits through the button", () => {
    const multi = widget("@ui multi\n- a\n- b\n@end")
    const toggled = activate(multi, 1).widget
    expect(activate(toggled, -1).outcome).toEqual({ type: "answer", value: "b" })
    const form = widget("@ui form\n- ok: bool no\n- kind: select x, y\n@end")
    const flipped = activate(activate(form, 0).widget, 1).widget
    expect(activate(flipped, 2).outcome).toEqual({ type: "answer", value: "ok=да; kind=y" })
  })

  test("a click on an input asks for the prompt, on a scale sets the value, on tabs switches page", () => {
    expect(activate(widget("@ui input\n@end"), 0).outcome).toEqual({ type: "focus-prompt" })
    const scale = activate(widget("@ui scale\nrange: 1-10\n@end"), 8).widget
    expect(activate(scale, -1).outcome).toEqual({ type: "answer", value: "8" })
    expect(text(activate(widget("@ui tabs\n# A\nпервая\n# B\nвторая\n@end"), 1).widget)).toContain("вторая")
  })
})

describe("rendering", () => {
  test("marks focus, shows hints and collapses once answered", () => {
    const w = widget("@ui choice Что?\n- один | первый\n- два\n@end")
    const active = text(w, "active")
    expect(active).toContain("╭ Что?")
    expect(active).toContain("▸")
    expect(active).toContain("первый")
    expect(active).toContain("Enter")
    expect(text(w, "pending")).toContain("ждёт вас")
    const done = render(keys(w, "enter").widget, 60, "idle")
    expect(done).toHaveLength(1)
    expect(done[0].map((span) => span.text).join("")).toContain("Что? → один")
  })

  test("clickable spans carry their target", () => {
    const w = widget("@ui choice\n- a\n- b\n@end")
    const targets = render(w, 60, "active").flatMap((line) => line.flatMap((span) => (span.target === undefined ? [] : [span.target])))
    expect(targets).toEqual([0, 1])
  })

  test("every kind renders at any width and the guide names them all", () => {
    const sources = [
      "@ui choice\n- a\n@end", "@ui multi\n- a\n@end", "@ui confirm\n@end", "@ui buttons\n- a\n@end", "@ui input\n@end",
      "@ui form\n- n: text\n@end", "@ui scale\n@end", "@ui table\ncols: a | b\n- 1 | 2\n@end", "@ui progress\n- p: 1/2\n@end",
      "@ui steps\n- x\n@end", "@ui diff\n+a\n@end", "@ui code\nx\n@end", "@ui kv\n- a: b\n@end", "@ui callout\nx\n@end",
      "@ui tabs\n# a\nb\n@end", "@ui rank\n- a\n@end", "@ui spark\nvalues: 1 1 1\n@end", "@ui timeline\n- 1 | a\n@end",
      "@ui tree\n- a\n@end", "@ui run\n- a\n@end",
    ]
    expect(sources).toHaveLength(KINDS.length)
    for (const source of sources) {
      const w = widget(source)
      expect(w.kind).toBe(KINDS[sources.indexOf(source)])
      for (const width of [0, 5, 12, 30, 120]) for (const focus of ["active", "pending", "idle"] as const) expect(render(w, width, focus).length).toBeGreaterThan(0)
    }
    for (const kind of KINDS) expect(GUIDE).toContain(kind)
  })

  test("wide characters are clipped by columns, not by characters", () => {
    expect(clip("日本語日本語", 7)).toBe("日本語…")
    expect(clip("short", 20)).toBe("short")
  })

  test("long text wraps at spaces and splits words longer than a line", () => {
    expect(wrap("short", 20)).toEqual(["short"])
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(wrap("日本語日本語", 6)).toEqual(["日本語", "日本語"])
  })

  test("table cells wrap instead of being cut with an ellipsis", () => {
    const status = "Реализован и верифицирован (>25k tok/s, Shannon H, Budget Control)"
    const w = widget(`@ui table Статус\ncols: компонент | статус\n- DeepSeek Dual-Stream Harness | ${status}\n- Integration Matrix & HUD | 37/37 PASS\n@end`)
    for (const width of [40, 60, 80]) {
      const drawn = text(w, "idle", width)
      expect(drawn).not.toContain("…")
      // Every word of the long cell is still on screen, even when it moved to a later line.
      for (const word of status.split(" ")) expect(drawn).toContain(word)
      for (const line of render(w, width, "idle")) expect(line.map((span) => span.text).join("").length).toBeLessThanOrEqual(width)
    }
  })

  test("summaries, notes and timelines wrap long values", () => {
    const long = "очень длинное значение которое раньше обрезалось многоточием на узком экране"
    for (const source of [`@ui kv\n- ключ: ${long}\n@end`, `@ui callout\n${long}\n@end`, `@ui timeline\n- 10:00 | ${long}\n@end`, `@ui steps\n- ${long}\n@end`]) {
      const drawn = text(widget(source), "idle", 40)
      expect(drawn).not.toContain("…")
      expect(drawn).toContain("многоточием")
    }
  })
})

describe("system prompt", () => {
  test("the core prompt file is exactly the guide the interface knows", () => {
    const file = new URL("../../core/src/plugin/system-prompt/interactive.txt", import.meta.url)
    expect(readFileSync(file, "utf8").trim()).toBe(GUIDE)
  })
})

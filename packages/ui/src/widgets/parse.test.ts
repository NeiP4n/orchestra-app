import { describe, expect, test } from "bun:test"
import { KINDS, parse, type Segment, type Widget } from "./parse"
import { activate, reply } from "./press"
import { setWidgetLanguage } from "./i18n"

function widget(source: string): Widget {
  const found = parse(source).find((segment): segment is Extract<Segment, { type: "widget" }> => segment.type === "widget")
  if (!found) throw new Error(`no widget in ${source}`)
  return found.widget
}

describe("widgets parser in @orchestra/ui", () => {
  test("parses text around blocks and drops wrapper code fences", () => {
    const segments = parse("Текст до:\n```\n@ui choice Выбор\n- а\n- б\n@end\n```\nТекст после.")
    expect(segments.map((s) => s.type)).toEqual(["text", "widget", "text"])
    expect(segments[0]).toEqual({ type: "text", text: "Текст до:" })
    expect(segments[2]).toEqual({ type: "text", text: "Текст после." })
  })

  test("handles block directly following text without blank lines", () => {
    const segments = parse("Сразу строка\n@ui choice Вариант\n- 1\n- 2\n@end\nИ продолжение")
    expect(segments.map((s) => s.type)).toEqual(["text", "widget", "text"])
    expect(segments[0]).toEqual({ type: "text", text: "Сразу строка" })
    expect(segments[2]).toEqual({ type: "text", text: "И продолжение" })
  })

  test("unknown, empty or invalid blocks remain plain text", () => {
    expect(parse("@ui nonexisting foo\n- x\n@end").map((s) => s.type)).toEqual(["text"])
    expect(parse("@ui choice\n@end").map((s) => s.type)).toEqual(["text"])
    expect(parse("hello @ui inside text").map((s) => s.type)).toEqual(["text"])
  })

  test("parses missing @end up to end of lines as expected by TUI", () => {
    const segments = parse("@ui choice Заголовок\n- а\n- б")
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe("widget")
    if (segments[0].type === "widget") {
      expect(segments[0].widget.kind).toBe("choice")
      expect(segments[0].widget.title).toBe("Заголовок")
    }
  })

  test("parses all 20 kinds properly", () => {
    const sources = [
      "@ui choice\n- a\n@end",
      "@ui multi\n- a\n@end",
      "@ui confirm\n@end",
      "@ui buttons\n- a\n@end",
      "@ui input\n@end",
      "@ui form\n- name: text Ivan\n@end",
      "@ui scale\nrange: 1-10\n@end",
      "@ui table\ncols: a | b\n- 1 | 2\n@end",
      "@ui progress\n- job: 40%\n@end",
      "@ui steps\n- [x] first\n@end",
      "@ui diff\n+line\n@end",
      "@ui code ts\nconst x = 1\n@end",
      "@ui kv\n- key: value\n@end",
      "@ui callout info\nmessage\n@end",
      "@ui tabs\n# tab1\ncontent\n@end",
      "@ui rank\n- a\n- b\n@end",
      "@ui spark\nvalues: 1 2 3\n@end",
      "@ui timeline\n- 10:00 | start\n@end",
      "@ui tree\n- root\n  - child\n@end",
      "@ui run\n- build | bun build\n@end",
    ]
    expect(sources).toHaveLength(KINDS.length)
    for (let i = 0; i < sources.length; i++) {
      const w = widget(sources[i])
      expect(w.kind).toBe(KINDS[i])
    }
  })

  test("replies and interactions work with i18n", () => {
    setWidgetLanguage("ru")
    const w = widget("@ui choice Вопрос\n- вариант 1\n- вариант 2\n@end")
    expect(reply(w, "вариант 1")).toBe("Ответ на «Вопрос»: вариант 1")
    expect(activate(w, 0).outcome).toEqual({ type: "answer", value: "вариант 1" })

    setWidgetLanguage("en")
    expect(reply(w, "option 1")).toBe("Answer to “Вопрос”: option 1")
  })

  test("generates correct reply format for all interactive kinds", () => {
    setWidgetLanguage("ru")

    const choiceW = widget("@ui choice Выбор\n- один\n@end")
    expect(reply(choiceW, "один")).toBe("Ответ на «Выбор»: один")

    const multiW = widget("@ui multi Выбор\n- [x] А\n- [x] Б\n@end")
    expect(reply(multiW, "А, Б")).toBe("Ответ на «Выбор»: А, Б")

    const confirmW = widget("@ui confirm Удалить?\nyes: Да\nno: Нет\n@end")
    expect(reply(confirmW, "Да")).toBe("Ответ на «Удалить?»: Да")

    const buttonsW = widget("@ui buttons Действие\n- Старт\n@end")
    expect(reply(buttonsW, "Старт")).toBe("Ответ на «Действие»: Старт")

    const inputW = widget("@ui input Ввод\n@end")
    expect(reply(inputW, "значение")).toBe("Ответ на «Ввод»: значение")

    const formW = widget("@ui form Анкета\n- Имя: text Иван\n@end")
    expect(reply(formW, "Имя=Иван")).toBe("Ответ на «Анкета»: Имя=Иван")

    const scaleW = widget("@ui scale Оценка\nrange: 1-5\n@end")
    expect(reply(scaleW, "5")).toBe("Ответ на «Оценка»: 5")

    const tableW = widget("@ui table Таблица\ncols: a | b\n- 1 | 2\nselect: true\n@end")
    expect(reply(tableW, "1 | 2")).toBe("Ответ на «Таблица»: 1 | 2")

    const diffW = widget("@ui diff Правка\n+строка\nactions: Применить | Отклонить\n@end")
    expect(reply(diffW, "Применить")).toBe("Ответ на «Правка»: Применить")

    const rankW = widget("@ui rank Приоритет\n- a\n- b\n@end")
    expect(reply(rankW, "b > a")).toBe("Ответ на «Приоритет»: b > a")

    const treeW = widget("@ui tree Файл\n- src\n  - main.ts\nselect: true\n@end")
    expect(reply(treeW, "src/main.ts")).toBe("Ответ на «Файл»: src/main.ts")

    const runW = widget("@ui run Команда\n- Тест | bun test\n@end")
    expect(reply(runW, "выполни `bun test`")).toBe("Ответ на «Команда»: выполни `bun test`")
  })
})

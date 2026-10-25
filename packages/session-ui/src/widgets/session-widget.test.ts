import { describe, expect, test } from "bun:test"
import { parse, reply } from "@orchestra/ui/widgets"
import { setWidgetLanguage } from "@orchestra/ui/widgets/i18n"

describe("GUI Session widgets integration", () => {
  test("parses markdown text into text and widget segments for GUI rendering", () => {
    const raw = "Вот возможные варианты:\n@ui choice Выбор БД\n- PostgreSQL | надежная\n- SQLite | быстрая\n@end\nЧто думаешь?"
    const segments = parse(raw)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ type: "text", text: "Вот возможные варианты:" })
    expect(segments[1].type).toBe("widget")
    expect(segments[2]).toEqual({ type: "text", text: "Что думаешь?" })

    if (segments[1].type === "widget") {
      const widget = segments[1].widget
      expect(widget.kind).toBe("choice")
      expect(widget.title).toBe("Выбор БД")
      if (widget.kind === "choice") {
        expect(widget.items).toHaveLength(2)
        expect(widget.items[0]).toEqual({ label: "PostgreSQL", hint: "надежная" })
        expect(widget.items[1]).toEqual({ label: "SQLite", hint: "быстрая" })
      }

      setWidgetLanguage("ru")
      expect(reply(widget, "PostgreSQL")).toBe("Ответ на «Выбор БД»: PostgreSQL")
    }
  })

  test("form format matches expected semicolon-separated key-values", () => {
    const raw = "@ui form Настройки\n- Хост: text localhost\n- Порт: number 5432\n- SSL: bool yes\n@end"
    const segments = parse(raw)
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe("widget")
    if (segments[0].type === "widget") {
      setWidgetLanguage("ru")
      expect(reply(segments[0].widget, "Хост=localhost; Порт=5432; SSL=да")).toBe(
        "Ответ на «Настройки»: Хост=localhost; Порт=5432; SSL=да",
      )
    }
  })

  test("run command reply format matches TUI exactly", () => {
    const raw = "@ui run Сборка\n- Собрать | bun run build\n@end"
    const segments = parse(raw)
    expect(segments).toHaveLength(1)
    if (segments[0].type === "widget") {
      setWidgetLanguage("ru")
      expect(reply(segments[0].widget, "выполни `bun run build`")).toBe(
        "Ответ на «Сборка»: выполни `bun run build`",
      )
    }
  })
})

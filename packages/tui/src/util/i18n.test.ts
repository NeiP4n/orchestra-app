import { describe, expect, test } from "bun:test"
import { translate } from "./i18n"

describe("TUI i18n", () => {
  test("keeps English UI text unchanged", () => {
    expect(translate("en", "Mesh status")).toBe("Mesh status")
    expect(translate("en", "Create Mesh")).toBe("Create Mesh")
    expect(translate("en", "Orchestrator council")).toBe("Orchestrator council")
  })

  test("translates LAN Rooms and Mesh UI to Russian", () => {
    expect(translate("ru", "Mesh status")).toBe("Состояние Mesh")
    expect(translate("ru", "Create Mesh")).toBe("Создать Mesh")
    expect(translate("ru", "Join Mesh")).toBe("Войти в Mesh")
    expect(translate("ru", "Leave Mesh")).toBe("Выйти из Mesh")
    expect(translate("ru", "Quorum healthy — shared writes are available")).toBe(
      "Кворум в норме — общие записи доступны",
    )
  })

  test("translates federation and project-group UI", () => {
    expect(translate("ru", "Single coordinator")).toBe("Один координатор")
    expect(translate("ru", "Orchestrator council")).toBe("Совет оркестраторов")
    expect(translate("ru", "Project groups")).toBe("Группы проектов")
    expect(translate("ru", "Start council")).toBe("Запустить совет")
  })

  test("preserves interpolation placeholders", () => {
    expect(translate("ru", "Servers found: {count}", { count: 3 })).toBe("Найдено серверов: 3")
    expect(translate("ru", "Quorum requires {count} of {total} devices", { count: 2, total: 3 })).toBe(
      "Для кворума нужно 2 из 3 устройств",
    )
    expect(translate("ru", "Coordinator: {leader}", { leader: "node-1" })).toBe("Координатор: node-1")
  })

  test("translates the standardized dialog strings", () => {
    expect(translate("ru", "Debug")).toBe("Отладка")
    expect(translate("ru", "No MCP servers")).toBe("Нет MCP-серверов")
    expect(translate("ru", "{count} MCP server(s)", { count: 2 })).toBe("MCP-серверов: 2")
    expect(translate("ru", "Needs authentication: {error}", { error: "expired" })).toBe("Нужна авторизация: expired")
    expect(translate("ru", "Reference: {ref}", { ref: "diag-1" })).toBe("Ссылка: diag-1")
    expect(translate("ru", "Themes")).toBe("Темы")
    expect(translate("ru", "Other")).toBe("Прочее")
    expect(translate("en", "Debug")).toBe("Debug")
  })

  test("falls back safely for untranslated strings", () => {
    const source = "A newly added English label"
    expect(translate("ru", source)).toBe(source)
    expect(translate(undefined, source)).toBe(source)
  })
})

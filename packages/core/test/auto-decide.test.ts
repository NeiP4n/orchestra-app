import { expect, test } from "bun:test"
import { AutoDecide } from "../src/tool/plugin/auto-decide.js"

test("a choice about money, secrets or publishing still reaches the operator", () => {
  expect(AutoDecide.sensitive("Which card should I pay with?")).toBe(true)
  expect(AutoDecide.sensitive("Введи пароль от аккаунта")).toBe(true)
  expect(AutoDecide.sensitive("Publish the release now?")).toBe(true)
})

test("a choice about how to solve the task is not sensitive", () => {
  expect(AutoDecide.sensitive("Какой сложный мод скачать?", "Tough As Nails (Рекомендуется)", "Хардкор выживание")).toBe(false)
  expect(AutoDecide.sensitive("Which library should I use?", "Option A", undefined)).toBe(false)
})

test("the recommended option is taken, else the first", () => {
  expect(AutoDecide.pick(["A", "B (Recommended)", "C"])).toBe(1)
  expect(AutoDecide.pick(["A", "Б (Рекомендуется)"])).toBe(1)
  expect(AutoDecide.pick(["A", "B", "C"], [false, false, true])).toBe(2)
  expect(AutoDecide.pick(["A", "B"])).toBe(0)
})

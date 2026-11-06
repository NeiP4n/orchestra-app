import { describe, expect, test } from "bun:test"
import {
  applyMutant,
  changeConstant,
  flipComparison,
  generateMutants,
  isValidMutant,
  negateCondition,
  swapLogic,
} from "./mutation-check"

describe("MutationOperators", () => {
  test("flip-comparison переворачивает каждое сравнение по отдельности", () => {
    expect(flipComparison("if (a === b) {")).toEqual([{ mutated: "if (a !== b) {", description: "=== → !==" }])
    expect(flipComparison("return x >= 10")).toEqual([{ mutated: "return x < 10", description: ">= → <" }])
    expect(flipComparison("while (n < limit && m > 0) {")).toEqual([
      { mutated: "while (n >= limit && m > 0) {", description: "< → >=" },
      { mutated: "while (n < limit && m <= 0) {", description: "> → <=" },
    ])
  })

  test("flip-comparison не трогает стрелки и сдвиги", () => {
    expect(flipComparison("const f = (x) => x + 1")).toEqual([])
    expect(flipComparison("const shifted = value << 2")).toEqual([])
  })

  test("negate-condition оборачивает условие if/while в отрицание", () => {
    expect(negateCondition("if (ready) {")).toEqual([{ mutated: "if (!(ready)) {", description: "условие → !(условие)" }])
    expect(negateCondition("while (queue.length > 0) {")).toEqual([
      { mutated: "while (!(queue.length > 0)) {", description: "условие → !(условие)" },
    ])
    expect(negateCondition("const x = 1")).toEqual([])
  })

  test("change-constant прибавляет 1 к числам и переворачивает boolean", () => {
    expect(changeConstant("const retries = 2")).toEqual([{ mutated: "const retries = 3", description: "2 → 3" }])
    expect(changeConstant("const enabled = true")).toEqual([{ mutated: "const enabled = false", description: "true → false" }])
    expect(changeConstant("if (n === 0) return")).toEqual([{ mutated: "if (n === 1) return", description: "0 → 1" }])
  })

  test("swap-logic меняет && на || и наоборот", () => {
    expect(swapLogic("if (a && b) {")).toEqual([{ mutated: "if (a || b) {", description: "&& → ||" }])
    expect(swapLogic("return x || y")).toEqual([{ mutated: "return x && y", description: "|| → &&" }])
  })

  test("generateMutants пропускает комментарии и нумерует строки с 1", () => {
    const source = [
      "// if (a === b) — комментарий, не мутируется",
      "export function check(a: number, b: number): boolean {",
      "  return a === b && a > 0",
      "}",
    ].join("\n")
    const mutants = generateMutants(source)

    expect(mutants.map((mutant) => mutant.line)).toEqual([3, 3, 3, 3])
    expect(mutants.map((mutant) => mutant.operator)).toEqual([
      "flip-comparison",
      "flip-comparison",
      "change-constant",
      "swap-logic",
    ])
    expect(mutants.every((mutant) => mutant.id > 0)).toBe(true)
  })

  test("applyMutant меняет только строку мутанта", () => {
    const source = "const a = 1\nconst b = 2\n"
    const [mutant] = generateMutants(source, ["change-constant"])

    expect(applyMutant(source, mutant!)).toBe("const a = 2\nconst b = 2\n")
  })

  test("isValidMutant отсекает мутант с синтаксической ошибкой", () => {
    const source = "export const x = a < b ? 1 : 2\n"
    const [mutant] = generateMutants(source, ["flip-comparison"])
    // `<` в тернарном операторе: переворот даёт `a >= b ? 1 : 2` — валидно.
    expect(isValidMutant(source, mutant!)).toBe(true)
    const broken = { ...mutant!, mutatedLine: "export const x = a < b ? 1 : " }
    expect(isValidMutant(source, broken)).toBe(false)
  })
})

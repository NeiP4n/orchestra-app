#!/usr/bin/env bun
// Мутационное тестирование критичных мест (идея #15 из лучших 25 общего подхода).
//
// Агент специально ломает код и проверяет, ловят ли это тесты: если тесты
// остаются зелёными после мутации — они мёртвые, и об этом надо знать до боя,
// а не в бою.
//
// Как это работает:
//   1. Скрипт читает целевой файл и строит мутантов — по одному маленькому
//      изменению на мутанта (переворот сравнения, отрицание условия,
//      изменение константы, замена &&/||).
//   2. Копия пакета с мутантом собирается во временной папке (рабочее дерево
//      не трогается никогда: мутации пишутся только во временную копию),
//      node_modules подключаются ссылками на настоящий install.
//   3. Тестовый файл прогоняется на каждом мутанте: упавшие тесты — мутант
//      убит (хорошо), зелёные тесты — мутант выжил (тесты мёртвые).
//   4. Мутанты с синтаксической ошибкой отсекаются до прогона проверкой
//      парсером Bun и в отчёт не идут.
//
// Usage:
//   bun script/mutation-check.ts <target-file> <test-file> [--only <op>] [--limit <n>] [--timeout-ms <n>] [--keep] [--json <path>]
//   bun script/mutation-check.ts packages/core/src/autoloop/kernel/evolve.ts packages/core/test/autoloop/evolve.test.ts
//
// Операторы: flip-comparison, negate-condition, change-constant, swap-logic.
// Код выхода 0 — все мутанты убиты; 1 — есть выжившие или зависшие; 2 — ошибка
// использования или красный baseline (тесты падают и без мутаций).
import { $ } from "bun"
import { cp, exists, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

export type MutationOperator = "flip-comparison" | "negate-condition" | "change-constant" | "swap-logic"

export const OPERATORS: MutationOperator[] = ["flip-comparison", "negate-condition", "change-constant", "swap-logic"]

export interface Mutant {
  id: number
  operator: MutationOperator
  /** 1-based номер строки в исходном файле. */
  line: number
  original: string
  mutated: string
  /** Полная мутированная строка (с отступами) — то, что пишется в файл. */
  mutatedLine: string
  description: string
}

export interface MutationResult {
  mutant: Mutant
  status: "killed" | "survived" | "timeout"
  /** Хвост вывода прогона тестов. */
  output: string
}

const COMPARISON_FLIPS: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  ">=": "<",
  "<=": ">",
  ">": "<=",
  "<": ">=",
}

const LOGIC_FLIPS: Record<string, string> = { "&&": "||", "||": "&&" }

/** Один мутант на каждое вхождение оператора сравнения в строке. */
export function flipComparison(line: string): Array<{ mutated: string; description: string }> {
  const found: Array<{ mutated: string; description: string }> = []
  for (const match of line.matchAll(/===|!==|>=|<=|>|</g)) {
    const op = match[0]
    const at = match.index ?? 0
    if (op === ">" && (line[at - 1] === "=" || line[at - 1] === ">" || line[at + 1] === ">")) continue // часть `=>` или `>>`
    if (op === "<" && (line[at - 1] === "<" || line[at + 1] === "<")) continue // часть `<<`
    const mutated = line.slice(0, at) + COMPARISON_FLIPS[op]! + line.slice(at + op.length)
    found.push({ mutated, description: `${op} → ${COMPARISON_FLIPS[op]}` })
  }
  return found
}

/** Один мутант на каждое условие if/while в строке: условие оборачивается в `!(...)`. */
export function negateCondition(line: string): Array<{ mutated: string; description: string }> {
  const found: Array<{ mutated: string; description: string }> = []
  for (const match of line.matchAll(/\b(?:if|while)\s*\(/g)) {
    const open = line.indexOf("(", match.index ?? 0)
    const close = matchingParen(line, open)
    if (close === -1) continue
    const condition = line.slice(open + 1, close)
    if (condition.trim() === "") continue
    const mutated = `${line.slice(0, open + 1)}!(${condition})${line.slice(close)}`
    found.push({ mutated, description: `условие → !(условие)` })
  }
  return found
}

function matchingParen(line: string, open: number): number {
  let depth = 0
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++
    if (line[i] === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Один мутант на каждую числовую константу (+1) и каждый boolean (переворот). */
export function changeConstant(line: string): Array<{ mutated: string; description: string }> {
  const found: Array<{ mutated: string; description: string }> = []
  for (const match of line.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$])/g)) {
    const text = match[1]!
    const at = match.index ?? 0
    const next = String(Number(text) + 1)
    found.push({
      mutated: line.slice(0, at) + next + line.slice(at + text.length),
      description: `${text} → ${next}`,
    })
  }
  for (const match of line.matchAll(/\b(true|false)\b/g)) {
    const text = match[1]!
    const at = match.index ?? 0
    const next = text === "true" ? "false" : "true"
    found.push({
      mutated: line.slice(0, at) + next + line.slice(at + text.length),
      description: `${text} → ${next}`,
    })
  }
  return found
}

/** Один мутант на каждое вхождение && или || в строке. */
export function swapLogic(line: string): Array<{ mutated: string; description: string }> {
  const found: Array<{ mutated: string; description: string }> = []
  for (const match of line.matchAll(/&&|\|\|/g)) {
    const op = match[0]
    const at = match.index ?? 0
    found.push({
      mutated: line.slice(0, at) + LOGIC_FLIPS[op]! + line.slice(at + op.length),
      description: `${op} → ${LOGIC_FLIPS[op]}`,
    })
  }
  return found
}

const MUTATORS: Record<MutationOperator, (line: string) => Array<{ mutated: string; description: string }>> = {
  "flip-comparison": flipComparison,
  "negate-condition": negateCondition,
  "change-constant": changeConstant,
  "swap-logic": swapLogic,
}

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

/**
 * Все мутанты исходника в детерминированном порядке: сверху вниз,
 * по операторам в порядке OPERATORS. Строки-комментарии пропускаются.
 */
export function generateMutants(source: string, operators: ReadonlyArray<MutationOperator> = OPERATORS): Mutant[] {
  const mutants: Mutant[] = []
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isCommentLine(line)) continue
    for (const operator of operators) {
      for (const change of MUTATORS[operator](line)) {
        mutants.push({
          id: mutants.length + 1,
          operator,
          line: i + 1,
          original: line.trim(),
          mutated: change.mutated.trim(),
          mutatedLine: change.mutated,
          description: change.description,
        })
      }
    }
  }
  return mutants
}

/** Применить мутанта к исходнику: заменить одну строку на мутированную. */
export function applyMutant(source: string, mutant: Mutant): string {
  const lines = source.split("\n")
  lines[mutant.line - 1] = mutant.mutatedLine
  return lines.join("\n")
}

/** Мутант валиден, когда мутированный файл парсится. Невалидный не запускается. */
export function isValidMutant(source: string, mutant: Mutant): boolean {
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(applyMutant(source, mutant))
    return true
  } catch {
    return false
  }
}

const findPackageDir = async (file: string): Promise<string> => {
  let dir = path.dirname(path.resolve(file))
  while (true) {
    if (await exists(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`пакет для ${file} не найден: нет package.json выше по дереву`)
    dir = parent
  }
}

const findRepoRoot = async (from: string): Promise<string> => {
  let dir = path.resolve(from)
  while (true) {
    if ((await exists(path.join(dir, "bun.lock"))) || (await exists(path.join(dir, "bun.lockb")))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error("корень репозитория не найден: нет bun.lock выше по дереву")
    dir = parent
  }
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", "coverage"])

async function copyPackage(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(from, src)
      if (rel === "") return true
      return !rel.split(path.sep).some((part) => SKIP_DIRS.has(part))
    },
  })
}

/** Ссылки на настоящий node_modules; указанный пакет ведёт на временную копию. */
async function linkNodeModules(realModules: string, tmpModules: string, pkgName: string, tmpPkg: string): Promise<void> {
  await mkdir(tmpModules, { recursive: true })
  for (const entry of await readdir(realModules, { withFileTypes: true })) {
    if (entry.name === ".bin") continue
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(tmpModules, entry.name)
      await mkdir(scopeDir, { recursive: true })
      for (const scoped of await readdir(path.join(realModules, entry.name), { withFileTypes: true })) {
        const name = `${entry.name}/${scoped.name}`
        const target = name === pkgName ? tmpPkg : path.join(realModules, name)
        await symlink(target, path.join(scopeDir, scoped.name))
      }
      continue
    }
    await symlink(path.join(realModules, entry.name), path.join(tmpModules, entry.name))
  }
}

async function linkAllNodeModules(repoRoot: string, pkgDir: string, tmpRoot: string, tmpPkg: string, pkgName: string): Promise<void> {
  const rootModules = path.join(repoRoot, "node_modules")
  if (!(await exists(rootModules))) {
    throw new Error(`node_modules нет в ${repoRoot} — сначала выполните bun install в рабочем дереве`)
  }
  await linkNodeModules(rootModules, path.join(tmpRoot, "node_modules"), pkgName, tmpPkg)
  // У пакета может быть свой node_modules (например, @vscode/ripgrep для
  // test/preload.ts в core) — его тоже подключаем ссылками, а не копируем.
  const pkgModules = path.join(pkgDir, "node_modules")
  if (await exists(pkgModules)) {
    await linkNodeModules(pkgModules, path.join(tmpPkg, "node_modules"), pkgName, tmpPkg)
  }
}

interface RunOutcome {
  code: number
  timedOut: boolean
  output: string
}

async function runTests(pkgDir: string, testRel: string, timeoutMs: number): Promise<RunOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  const proc = Bun.spawn(["bun", "test", testRel], {
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  const output = [stdout, stderr].join("\n").trim().slice(-3000)
  return { code, timedOut: signal.aborted, output }
}

const tail = (text: string, lines = 12): string => text.split("\n").slice(-lines).join("\n")

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h") || args.length < 2) {
    console.log(
      "usage: bun script/mutation-check.ts <target-file> <test-file> [--only <op>] [--limit <n>] [--timeout-ms <n>] [--keep] [--json <path>]",
    )
    console.log(`ops: ${OPERATORS.join(", ")}`)
    return args.length < 2 ? 2 : 0
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--only" || arg === "--limit" || arg === "--timeout-ms" || arg === "--json") {
      i++
      continue
    }
    if (!arg.startsWith("--")) positional.push(arg)
  }
  const [targetArg, testArg] = positional
  const targetFile = path.resolve(targetArg!)
  const testFile = path.resolve(testArg!)
  const only = flag("--only") as MutationOperator | undefined
  if (only !== undefined && !OPERATORS.includes(only)) {
    console.error(`mutation-check: неизвестный оператор ${only}; допустимые: ${OPERATORS.join(", ")}`)
    return 2
  }
  const limit = Number(flag("--limit") ?? 50)
  const timeoutMs = Number(flag("--timeout-ms") ?? 120_000)
  const keep = args.includes("--keep")
  const jsonPath = flag("--json")
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.error("mutation-check: --limit и --timeout-ms должны быть целыми положительными числами")
    return 2
  }
  if (!(await exists(targetFile)) || !(await exists(testFile))) {
    console.error(`mutation-check: файлы не найдены: ${targetFile}, ${testFile}`)
    return 2
  }

  const pkgDir = await findPackageDir(targetFile)
  const testPkgDir = await findPackageDir(testFile)
  if (pkgDir !== testPkgDir) {
    console.error("mutation-check: целевой файл и тестовый файл должны быть в одном пакете")
    return 2
  }
  const pkgJson = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as { name?: string }
  const pkgName = pkgJson.name ?? path.basename(pkgDir)
  const repoRoot = await findRepoRoot(pkgDir)
  const source = await readFile(targetFile, "utf8")

  const operators = only === undefined ? OPERATORS : [only]
  const all = generateMutants(source, operators)
  const valid = all.filter((mutant) => isValidMutant(source, mutant))
  const invalid = all.length - valid.length
  const mutants = valid.slice(0, limit)
  console.log(
    `mutation-check: ${path.relative(repoRoot, targetFile)} — мутантов найдено ${all.length}, ` +
      `невалидных (ошибка парсинга) ${invalid}, к прогону ${mutants.length}` +
      (all.length > mutants.length ? ` (лимит ${limit})` : ""),
  )

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "mutation-check-"))
  const tmpPkg = path.join(tmpRoot, "pkg")
  try {
    await copyPackage(pkgDir, tmpPkg)
    await linkAllNodeModules(repoRoot, pkgDir, tmpRoot, tmpPkg, pkgName)
    for (const name of ["tsconfig.json", "bunfig.toml"]) {
      const from = path.join(repoRoot, name)
      if (await exists(from)) await cp(from, path.join(tmpRoot, name))
    }
    const testRel = path.relative(pkgDir, testFile)
    const targetRel = path.relative(pkgDir, targetFile)
    const tmpTarget = path.join(tmpPkg, targetRel)
    const tmpSource = await readFile(tmpTarget, "utf8")

    console.log("mutation-check: baseline — тесты без мутаций…")
    const baseline = await runTests(tmpPkg, testRel, timeoutMs)
    if (baseline.timedOut || baseline.code !== 0) {
      console.error("mutation-check: baseline красный — чините тесты до мутаций:")
      console.error(tail(baseline.output))
      return 2
    }
    console.log("mutation-check: baseline зелёный")

    const results: MutationResult[] = []
    for (const mutant of mutants) {
      await writeFile(tmpTarget, applyMutant(tmpSource, mutant), "utf8")
      const run = await runTests(tmpPkg, testRel, timeoutMs)
      const status = run.timedOut ? "timeout" : run.code === 0 ? "survived" : "killed"
      results.push({ mutant, status, output: run.output })
      console.log(`  #${mutant.id} [${mutant.operator}] стр. ${mutant.line}: ${mutant.description} — ${status}`)
      await writeFile(tmpTarget, tmpSource, "utf8")
    }

    const killed = results.filter((result) => result.status === "killed").length
    const survived = results.filter((result) => result.status === "survived")
    const timedOut = results.filter((result) => result.status === "timeout")
    console.log(
      `mutation-check: итог — убито ${killed}/${results.length}, выжило ${survived.length}, зависло ${timedOut.length}`,
    )
    if (survived.length > 0) {
      console.log("mutation-check: ВЫЖИВШИЕ мутанты — тесты их не ловят:")
      for (const result of survived) {
        console.log(
          `  #${result.mutant.id} [${result.mutant.operator}] стр. ${result.mutant.line}: ${result.mutant.original} → ${result.mutant.mutated}`,
        )
      }
    }
    if (timedOut.length > 0) {
      console.log("mutation-check: зависшие прогоны — проверьте вручную, возможно, мутация вешает тесты:")
      for (const result of timedOut) {
        console.log(`  #${result.mutant.id} [${result.mutant.operator}] стр. ${result.mutant.line}`)
      }
    }
    if (jsonPath !== undefined) {
      await writeFile(
        path.resolve(jsonPath),
        JSON.stringify({ target: path.relative(repoRoot, targetFile), test: path.relative(repoRoot, testFile), killed, survived: survived.length, timedOut: timedOut.length, invalid, results }, null, 2),
        "utf8",
      )
      console.log(`mutation-check: JSON-отчёт — ${jsonPath}`)
    }
    return survived.length + timedOut.length === 0 ? 0 : 1
  } finally {
    if (keep) {
      console.log(`mutation-check: временная копия сохранена — ${tmpRoot}`)
    } else {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  process.exitCode = await main()
}

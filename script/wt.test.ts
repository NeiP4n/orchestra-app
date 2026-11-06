import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Тесты helper-скрипта script/wt.sh — стандарта работы с worktree.
// Всё гоняется на временных git-репозиториях в /tmp: реальный репозиторий
// и живой сервер не трогаются, пуша нет нигде.
const WT = fileURLToPath(new URL("./wt.sh", import.meta.url))

const HOME = process.env.HOME ?? ""
const GIT_ENV = {
  ...process.env,
  PATH: `${HOME}/.local/bin:${process.env.PATH ?? ""}`,
  GIT_AUTHOR_NAME: "wt-test",
  GIT_AUTHOR_EMAIL: "wt-test@example.local",
  GIT_COMMITTER_NAME: "wt-test",
  GIT_COMMITTER_EMAIL: "wt-test@example.local",
}

type RunResult = { status: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = GIT_ENV): RunResult {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function wt(args: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  return run("bash", [WT, ...args], cwd, { ...GIT_ENV, ...extraEnv })
}

function makeRepo(): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"))
  const repo = join(dir, "repo")
  run("mkdir", ["-p", repo], dir)
  expect(run("git", ["init", "-q", "-b", "main", repo], dir).status).toBe(0)
  writeFileSync(join(repo, "a.txt"), "a\n")
  expect(run("git", ["-C", repo, "add", "."], dir).status).toBe(0)
  expect(run("git", ["-C", repo, "commit", "-qm", "init"], dir).status).toBe(0)
  return { dir, repo }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

// `wt remove` / `wt merge` убирают worktree в фоне: после возврата команды
// каталог может ещё существовать доли секунды. Ждём исчезновения, а не
// полагаемся на удачу планировщика.
function waitForGone(path: string, timeoutMs = 10000): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return !existsSync(path)
}

// Удаление ветки тоже фоновое: ждём, пока `git branch --list` её не потеряет.
function waitForBranchGone(repo: string, branch: string, timeoutMs = 10000): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run("git", ["-C", repo, "branch", "--list", branch], repo).stdout.trim() === "") return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return run("git", ["-C", repo, "branch", "--list", branch], repo).stdout.trim() === ""
}

const hasWt = spawnSync("sh", ["-c", "command -v wt"], { encoding: "utf8", env: GIT_ENV }).status === 0

describe("validate-name", () => {
  test("принимает короткие имена через дефис", () => {
    const { dir, repo } = makeRepo()
    try {
      for (const name of ["a", "news-worktrunk", "b16-gaps", "fix-scroll-state", "main"]) {
        expect(wt(["validate-name", name], repo).status).toBe(0)
      }
    } finally {
      cleanup(dir)
    }
  })

  test("отклоняет слеши, префиксы, подчёркивания и длинные имена", () => {
    const { dir, repo } = makeRepo()
    try {
      for (const name of ["feat/x", "news/worktrunk", "Fix", "a_b", "a-b-c-d", "a--b", "-a", "a-", ""]) {
        expect(wt(["validate-name", name], repo).status).not.toBe(0)
      }
    } finally {
      cleanup(dir)
    }
  })
})

describe("new / check / merge (git fallback)", () => {
  const noWt = { WT_NO_WORKTRUNK: "1" }

  test("new создаёт ветку и worktree от main по стандартному пути", () => {
    const { dir, repo } = makeRepo()
    try {
      const mainSha = run("git", ["-C", repo, "rev-parse", "HEAD"], dir).stdout.trim()
      const path = join(dir, "orchestra-app-test-branch")
      const created = wt(["new", "test-branch"], repo, noWt)
      expect(created.status).toBe(0)
      expect(existsSync(join(path, "a.txt"))).toBe(true)
      expect(run("git", ["-C", path, "rev-parse", "HEAD"], dir).stdout.trim()).toBe(mainSha)
      expect(run("git", ["-C", path, "branch", "--show-current"], dir).stdout.trim()).toBe("test-branch")
      // повторное создание той же ветки — отказ
      expect(wt(["new", "test-branch"], repo, noWt).status).not.toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  test("path печатает стандартный путь worktree", () => {
    const { dir, repo } = makeRepo()
    try {
      const r = wt(["path", "test-branch"], repo, noWt)
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe(join(dir, "orchestra-app-test-branch"))
    } finally {
      cleanup(dir)
    }
  })

  test("check: чистое дерево проходит, грязное и симлинк — нет", () => {
    const { dir, repo } = makeRepo()
    try {
      expect(wt(["new", "test-branch"], repo, noWt).status).toBe(0)
      const path = join(dir, "orchestra-app-test-branch")
      expect(wt(["check", path], repo, noWt).status).toBe(0)
      writeFileSync(join(path, "dirty.txt"), "x\n")
      expect(wt(["check", path], repo, noWt).status).not.toBe(0)
      rmSync(join(path, "dirty.txt"))
      run("ln", ["-s", "/nonexistent", join(path, "node_modules")], dir)
      expect(wt(["check", path], repo, noWt).status).not.toBe(0)
      // setup убирает симлинк и после этого check снова проходит
      expect(wt(["setup", path], repo, noWt).status).toBe(0)
      expect(existsSync(join(path, "node_modules"))).toBe(false)
      expect(wt(["check", path], repo, noWt).status).toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  test("merge сливает ветку в main merge-коммитом и убирает worktree и ветку", () => {
    const { dir, repo } = makeRepo()
    try {
      expect(wt(["new", "test-branch"], repo, noWt).status).toBe(0)
      const path = join(dir, "orchestra-app-test-branch")
      writeFileSync(join(path, "b.txt"), "b\n")
      expect(run("git", ["-C", path, "add", "."], dir).status).toBe(0)
      expect(run("git", ["-C", path, "commit", "-qm", "feat: b"], dir).status).toBe(0)
      const merged = wt(["merge", "test-branch"], repo, noWt)
      expect(merged.status).toBe(0)
      const log = run("git", ["-C", repo, "log", "--oneline", "-2"], dir).stdout
      expect(log).toContain("Merge branch 'test-branch' into main")
      expect(existsSync(path)).toBe(false)
      expect(run("git", ["-C", repo, "branch", "--list", "test-branch"], dir).stdout.trim()).toBe("")
      expect(existsSync(join(repo, "b.txt"))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  test("merge отказывается мержить не из worktree main", () => {
    const { dir, repo } = makeRepo()
    try {
      expect(wt(["new", "test-branch"], repo, noWt).status).toBe(0)
      const path = join(dir, "orchestra-app-test-branch")
      expect(wt(["merge", "test-branch"], path, noWt).status).not.toBe(0)
    } finally {
      cleanup(dir)
    }
  })
})

describe("wt (worktrunk) path", () => {
  // Пропускаем, если wt не установлен: тогда работает только git fallback.
  const maybe = hasWt ? test : test.skip

  maybe("new/remove через wt создают и убирают worktree и ветку", () => {
    const { dir, repo } = makeRepo()
    try {
      const path = join(dir, "orchestra-app-wt-branch")
      expect(wt(["new", "wt-branch"], repo).status).toBe(0)
      expect(existsSync(join(path, "a.txt"))).toBe(true)
      expect(run("git", ["-C", path, "branch", "--show-current"], dir).stdout.trim()).toBe("wt-branch")
      expect(wt(["remove", "wt-branch", "--force"], repo).status).toBe(0)
      expect(waitForGone(path)).toBe(true)
      expect(waitForBranchGone(repo, "wt-branch")).toBe(true)
    } finally {
      cleanup(dir)
    }
  }, 30000)

  maybe("merge через wt делает merge-коммит, а не squash", () => {
    const { dir, repo } = makeRepo()
    try {
      expect(wt(["new", "wt-branch"], repo).status).toBe(0)
      const path = join(dir, "orchestra-app-wt-branch")
      writeFileSync(join(path, "b.txt"), "b\n")
      expect(run("git", ["-C", path, "add", "."], dir).status).toBe(0)
      expect(run("git", ["-C", path, "commit", "-qm", "feat: b"], dir).status).toBe(0)
      expect(wt(["merge", "wt-branch"], repo).status).toBe(0)
      const log = run("git", ["-C", repo, "log", "--oneline", "--graph", "-3"], dir).stdout
      expect(log).toContain("Merge branch 'wt-branch' into main")
      expect(waitForGone(path)).toBe(true)
    } finally {
      cleanup(dir)
    }
  }, 30000)
})

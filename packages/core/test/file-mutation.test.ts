import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { FileMutation } from "@orchestra/core/file-mutation"
import { Environment } from "@orchestra/core/environment/index"
import { Location } from "@orchestra/core/location"
import { FileAccess } from "@orchestra/core/file-access"
import { Permission } from "@orchestra/core/permission"
import { AbsolutePath } from "@orchestra/core/schema"
import { type EnvironmentFilesTransform, transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

function provide(directory: string, transformFiles: EnvironmentFilesTransform = () => ({})) {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, FileMutation.node]), [
      Location.node.replace(activeLocation),
      Permission.node.replace(permissionLayer()),
      Environment.node.replace(transformEnvironmentFiles(transformFiles)),
    ]),
  )
}

describe("FileMutation", () => {
  it.live("writes an existing internal file and returns a stable result", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })

        expect(yield* (yield* FileMutation.Service).write({ target, content: "after" })).toEqual({
          operation: "write",
          target: target.absolute,
          resource: "hello.txt",
          existed: true,
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes a prospective internal file and creates parent directories", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({
          path: path.join("src", "nested", "hello.txt"),
        })
        const result = yield* (yield* FileMutation.Service).write({ target, content: "hello" })

        expect(result).toEqual({
          operation: "write",
          target: target.absolute,
          resource: "src/nested/hello.txt",
          existed: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(target.absolute, "utf8"))).toBe("hello")
      }).pipe(provide(directory)),
    ),
  )

  it.live("preserves exactly one BOM for text writes and normalizes created text", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const preservedPath = path.join(directory, "preserved.txt")
        yield* Effect.promise(() => fs.writeFile(preservedPath, "\uFEFFbefore"))
        const access = yield* FileAccess.Service
        const preserved = yield* access.resolve({ path: "preserved.txt" })
        const created = yield* access.resolve({ path: "created.txt" })
        const files = yield* FileMutation.Service

        yield* files.writeTextPreservingBom({ target: preserved, content: "\uFEFFafter" })
        yield* files.writeTextPreservingBom({ target: created, content: "\uFEFF\uFEFF\uFEFFcreated" })

        expect(yield* Effect.promise(() => fs.readFile(preservedPath, "utf8"))).toBe("\uFEFFafter")
        expect(yield* Effect.promise(() => fs.readFile(created.absolute, "utf8"))).toBe("\uFEFFcreated")
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes an explicitly resolved external target", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "external.txt")
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          const result = yield* (yield* FileMutation.Service).write({ target, content: "external" })

          expect(result).toEqual({
            operation: "write",
            target: target.absolute,
            resource: target.resource,
            existed: false,
          })
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("external")
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("serializes concurrent writes to the same absolute target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "initial"))
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          Effect.gen(function* () {
            writes++
            if (writes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            } else {
              yield* Deferred.succeed(secondStarted, undefined)
            }
            yield* write
          }),
        )

        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* access.resolve({ path: "shared.txt" })
          const secondPlan = yield* access.resolve({ path: "shared.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(secondStarted)).toBe(false)

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Deferred.await(secondStarted)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("second")
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("shares transaction locks across Location service instances", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const target = path.join(directory, "shared.txt")
        const first = yield* Effect.gen(function* () {
          const files = yield* FileMutation.Service
          yield* files.withLock([target])(
            Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
          )
        }).pipe(provide(directory), Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const second = yield* Effect.gen(function* () {
          const files = yield* FileMutation.Service
          yield* files.withLock([target])(Deferred.succeed(secondStarted, undefined))
        }).pipe(provide(directory), Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(secondStarted)).toBe(false)

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    ),
  )

  it.live("allows transaction locks for distinct resolved paths to proceed independently", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondFinished = yield* Deferred.make<void>()
        const files = yield* FileMutation.Service
        const first = yield* files
          .withLock([path.join(directory, "first.txt")])(
            Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* files.withLock([path.join(directory, "second.txt")])(Deferred.succeed(secondFinished, undefined))
        expect(yield* Deferred.isDone(secondFinished)).toBe(true)

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
      }).pipe(provide(directory)),
    ),
  )

  it.live("restores the previous content when the atomic rename fails", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })
        const files = yield* FileMutation.Service

        const result = yield* files.write({ target, content: "after" }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        // The torn write never reaches the reader: the old bytes are back.
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("before")
        expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(["hello.txt"])
      }).pipe(
        provide(directory, (files) => ({
          move: () =>
            Effect.fail(new Environment.Failed({ path: "hello.txt", cause: new Error("rename failed") })),
        })),
      ),
    ),
  )

  it.live("steals a stale cross-process lock instead of blocking forever", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        // A lockfile from a dead process: our own pid, but untouched for a minute.
        const lockPath = `${targetPath}.orchestra-lock`
        yield* Effect.promise(() => fs.writeFile(lockPath, `${process.pid}\n${Date.now() - 60_000}\n`))
        yield* Effect.promise(() => fs.utimes(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })
        const files = yield* FileMutation.Service

        yield* files.write({ target, content: "after" })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
        expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(["hello.txt"])
      }).pipe(provide(directory)),
    ),
  )

  it.live("leaves no temp file or lock file behind after a write", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })
        const files = yield* FileMutation.Service

        yield* files.write({ target, content: "hello" })
        expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(["hello.txt"])
      }).pipe(provide(directory)),
    ),
  )

  it.live("allows distinct absolute targets to proceed independently", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondFinished = yield* Deferred.make<void>()
        const secondPath = path.join(directory, "second.txt")
        let writes = 0
        // Writes land atomically: files.write goes to a temp file and only the
        // rename makes the content visible, so "second finished" is signalled
        // by the rename of second.txt, not by its temp write.
        const filesystem: EnvironmentFilesTransform = (files) => ({
          write: (target, content) =>
            ++writes === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                  Effect.andThen(files.write(target, content)),
                )
              : files.write(target, content),
          move: (from, to) =>
            files.move(from, to).pipe(
              Effect.andThen(() =>
                to === secondPath ? Deferred.succeed(secondFinished, undefined) : Effect.void,
              ),
            ),
        })

        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* access.resolve({ path: "first.txt" })
          const secondPlan = yield* access.resolve({ path: "second.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Deferred.await(secondFinished)
          expect(yield* Effect.promise(() => fs.readFile(secondPath, "utf8"))).toBe("second")

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )
})

function instrumentWrites(
  run: <E>(write: Effect.Effect<void, E>, target: string) => Effect.Effect<void, E>,
): EnvironmentFilesTransform {
  return (files) => ({ write: (target, content) => run(files.write(target, content), target) })
}

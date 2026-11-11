// Opt-in local fixture. Uses temporary state and two real PTYs, never user terminals or models.
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Location } from "../../src/location"
import { Bus } from "../../src/bus"
import { Pty } from "../../src/pty"
import { PersistentPty } from "../../src/persistent-pty"
import { Session } from "../../src/session"
import { ConsoleTool } from "../../src/tool/plugin/console"
import { ConsoleAccess as A } from "../../src/console-access"
const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-native-console-"))
process.env.ORCHESTRA_STATE_DIR = root
const sessionID = Session.ID.make("ses_console_native")
const metadata = { "orchestra:project-owner": { projectID: "prj_console_native" } }
const layer = AppNodeBuilder.build(LayerNode.group([Pty.node, PersistentPty.node, Bus.node]), [
  Global.node.replace(
    Global.layerWith({
      state: root,
      data: root,
      config: root,
      cache: root,
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
      tmp: root,
    }),
  ),
  Location.node.replace(
    Layer.succeed(
      Location.Service,
      Location.Service.of({
        directory: root,
        worktree: root,
        project: { id: "test", worktree: root, time: { created: 0 } },
        env: {},
      } as any),
    ),
  ),
])
try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plain = yield* Pty.Service,
          persistent = yield* PersistentPty.Service
        let tool: any
        yield* ConsoleTool.Plugin.effect({
          tool: { transform: (fn: any) => Effect.sync(() => fn({ add: (value: any) => (tool = value) })) },
        } as any).pipe(
          Effect.provideService(Session.Service, {
            get: () => Effect.succeed({ id: sessionID, location: { directory: root }, metadata }),
          } as any),
        )
        for (const kind of ["plain", "persistent"] as const) {
          const info =
            kind === "plain"
              ? yield* plain.create({ command: "/bin/sh", args: ["-i"], cwd: root })
              : yield* persistent.create(sessionID, {
                  command: "/bin/sh",
                  args: ["-i"],
                  cwd: root,
                  title: "Native console fixture",
                  env: { TERM: "xterm-256color" },
                })
          const scope = { sessionID, directory: root, projectID: "prj_console_native", kind, ptyID: info.id }
          const execute = (action: string, text?: string): Effect.Effect<{ content: string }, unknown> =>
            tool.execute({ action, text }, { sessionID })
          try {
            A.select(scope)
            if (kind === "persistent") yield* persistent.resize(info.id, 80, 24)
            const off = yield* Effect.exit(execute("write", "printf OFF_SHOULD_NOT_RUN\\n\n"))
            if (off._tag !== "Failure") throw Error("OFF wrote")
            if (kind === "persistent" && (yield* Effect.exit(persistent.read(sessionID)))._tag !== "Failure")
              throw Error("legacy OFF read")
            A.set(scope, "read")
            yield* execute("read")
            if (kind === "persistent" && !(yield* persistent.read(sessionID)))
              throw Error("legacy read missing terminal")
            A.set(scope, "confirm")
            const command = "printf 'NATIVE_%s_PROOF\\n' CONSOLE\n"
            const pending = yield* Effect.exit(execute("write", command))
            if (pending._tag !== "Failure") throw Error("unapproved write")
            const grant = A.current(scope)
            A.approve(scope, grant.pending!, grant.revision)
            yield* execute("write", command)
            yield* Effect.promise(() => new Promise((done) => setTimeout(done, 300)))
            const result = yield* execute("read")
            if (!result.content.includes("NATIVE_CONSOLE_PROOF"))
              throw Error(kind + " missing output: " + result.content)
            A.set(scope, "off")
            if ((yield* Effect.exit(execute("read")))._tag !== "Failure") throw Error("revoked read")
            A.set(scope, "read")
            A.unselect(scope)
            if ((yield* Effect.exit(execute("read")))._tag !== "Failure") throw Error("closed Console still readable")
            if (kind === "persistent" && (yield* Effect.exit(persistent.read(sessionID)))._tag !== "Failure")
              throw Error("legacy closed read")
            console.log(
              "PASS native " + kind + " OFF/read/exact-confirm/output/revoke/close + legacy persistent read guard",
            )
          } finally {
            A.set(scope, "off")
            if (kind === "plain") yield* plain.remove(info.id)
            else yield* persistent.remove(info.id)
          }
        }
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provideService(Location.Service, {
        directory: root,
        worktree: root,
        project: { id: "test", worktree: root, time: { created: 0 } },
        env: {},
      } as any),
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

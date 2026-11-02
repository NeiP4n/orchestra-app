import { Effect } from "effect"
import { MachineRpcs } from "../../shared/ipc-rpc/machines"
import { DesktopStorage } from "../storage"
import {
  createExecFileExecutor,
  detectContainerRuntime,
  execInContainer,
  isContainerRunning,
  logsContainer,
  removeContainer,
  setContainerNetwork,
  snapshotContainer,
  startContainer,
  stopContainer,
} from "../machines/runner"
import { snapshotImage } from "../machines/driver"
import { spawnAppleVzMachine } from "../machines/apple-vz-runner"
import { createNodeSpawn, type SpawnedProcess } from "../machines/firecracker-spawn"
import { spawnWslKeepAlive, terminateWslMachine, verifyWslMachine } from "../machines/wsl-runner"
import {
  createMachine,
  deleteMachine,
  listMachines,
  parseMachine,
  setMachineNetwork,
  setMachineSnapshot,
  updateMachineStatus,
} from "../machines/store"

const namespace = "machines"

const appleVzProcesses = new Map<string, SpawnedProcess>()

const wslProcesses = new Map<string, SpawnedProcess>()

export const machineHandlers = MachineRpcs.toLayer(
  Effect.gen(function* () {
    const storage = yield* DesktopStorage.Service

    return MachineRpcs.of({
      MachinesList: () => Effect.sync(() => listMachines(storage.state.items(namespace).items)),
      MachinesCreate: ({ name, backend, cpu, memoryMb, diskGb, network }) =>
        Effect.sync(() => {
          const current = storage.state.items(namespace).items
          const id = `machine_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          const created = createMachine(current, { name, backend, cpu, memoryMb, diskGb, network }, id, Date.now())

          storage.state.update(namespace, { [id]: JSON.stringify(created.machine) }, [])

          return created.machine
        }),
      MachinesUpdateStatus: ({ id, status }) =>
        Effect.sync(() => {
          const current = storage.state.items(namespace).items
          const updated = updateMachineStatus(current, id, status)

          storage.state.update(namespace, { [id]: JSON.stringify(updated.machine) }, [])

          return updated.machine
        }),
      MachinesDelete: ({ id }) =>
        Effect.gen(function* () {
          const raw = storage.state.items(namespace).items[id]

          if (raw) {
            const machine = parseMachine(raw)
            const exec = createExecFileExecutor()

            // Delete must clean up the backend, not just the record:
            // otherwise a deleted running machine keeps living with no
            // record and no cleanup path, and its name blocks the next
            // start. Cleanup is best-effort — a failed cleanup must not
            // trap the user with an undeletable record.
            if (machine.backend === "container") {
              // Stop and remove are independently best-effort: a container
              // that is already stopped still needs removing, so a failed
              // stop must not skip the remove.
              yield* Effect.tryPromise(() => detectContainerRuntime(exec))
                .pipe(
                  Effect.andThen((runtime) =>
                    Effect.tryPromise(() => stopContainer(exec, runtime, machine)).pipe(
                      Effect.ignore,
                      Effect.andThen(() => Effect.tryPromise(() => removeContainer(exec, runtime, machine))),
                      Effect.ignore,
                    ),
                  ),
                  Effect.ignore,
                )
            } else if (machine.backend === "wsl") {
              yield* Effect.tryPromise(() => terminateWslMachine(exec, machine)).pipe(Effect.ignore)
              wslProcesses.get(id)?.kill()
              wslProcesses.delete(id)
            } else if (machine.backend === "apple-vz") {
              appleVzProcesses.get(id)?.kill()
              appleVzProcesses.delete(id)
            }
          }

          const current = storage.state.items(namespace).items
          const next = deleteMachine(current, id)

          storage.state.update(namespace, {}, [id])

          return void next
        }),
      MachinesStart: ({ id }) =>
        Effect.gen(function* () {
          const save = (status: "starting" | "running" | "error") => {
            const current = storage.state.items(namespace).items
            const updated = updateMachineStatus(current, id, status)

            storage.state.update(namespace, { [id]: JSON.stringify(updated.machine) }, [])

            return updated.machine
          }

          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend === "wsl") {
            if (machine.status !== "stopped" && machine.status !== "error") {
              return yield* Effect.fail(new Error(`Machine ${id} cannot start from ${machine.status}`))
            }

            save("starting")

            const exec = createExecFileExecutor()

            try {
              yield* Effect.tryPromise(() => verifyWslMachine(exec, machine))
              const spawned = spawnWslKeepAlive(createNodeSpawn(), machine)
              wslProcesses.set(id, spawned)

              // "Running" must be verified, not assumed: if the keep-alive
              // died at once (or its binary is missing), the distro is not
              // actually up, and claiming "running" is a phantom machine.
              yield* Effect.tryPromise(() => verifyWslMachine(exec, machine))

              if (spawned.error) throw spawned.error
            } catch (error) {
              wslProcesses.get(id)?.kill()
              wslProcesses.delete(id)
              save("error")

              return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
            }

            return save("running")
          }

          if (machine.backend === "apple-vz") {
            if (machine.status !== "stopped" && machine.status !== "error") {
              return yield* Effect.fail(new Error(`Machine ${id} cannot start from ${machine.status}`))
            }

            save("starting")

            const kernelPath = process.env.ORCHESTRA_VZ_KERNEL ?? ""
            const diskPath = process.env.ORCHESTRA_VZ_DISK ?? ""

            if (!kernelPath || !diskPath) {
              save("error")

              return yield* Effect.fail(
                new Error("Apple Vz machine needs ORCHESTRA_VZ_KERNEL and ORCHESTRA_VZ_DISK paths"),
              )
            }

            try {
              appleVzProcesses.set(
                id,
                spawnAppleVzMachine(createNodeSpawn(), machine, { kernelPath, diskPath }),
              )
            } catch (error) {
              save("error")

              return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
            }

            return save("running")
          }

          if (machine.backend !== "container") {
            return yield* Effect.fail(new Error(`Machine ${id} backend ${machine.backend} cannot start yet`))
          }

          if (machine.status !== "stopped" && machine.status !== "error") {
            return yield* Effect.fail(new Error(`Machine ${id} cannot start from ${machine.status}`))
          }

          save("starting")

          const exec = createExecFileExecutor()

          try {
            const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

            // A snapshot, when one exists, is the machine: starting from the
            // base image after a snapshot silently discards it, so the
            // snapshot image is the start image whenever it is set.
            const image = machine.snapshotId ? snapshotImage(machine, machine.snapshotId) : undefined

            yield* Effect.tryPromise(() => startContainer(exec, runtime, machine, image))

            // docker run -d exits 0 even when the container exits at once
            // (bad image, bad command), so verify it is actually running.
            const running = yield* Effect.tryPromise(() => isContainerRunning(exec, runtime, machine))

            if (!running) throw new Error(`Container for machine ${id} exited immediately after start`)
          } catch (error) {
            save("error")

            return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
          }

          return save("running")
        }),
      MachinesStop: ({ id }) =>
        Effect.gen(function* () {
          const save = (status: "stopping" | "stopped" | "error") => {
            const current = storage.state.items(namespace).items
            const updated = updateMachineStatus(current, id, status)

            storage.state.update(namespace, { [id]: JSON.stringify(updated.machine) }, [])

            return updated.machine
          }

          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend === "wsl") {
            if (machine.status !== "running" && machine.status !== "starting") {
              return yield* Effect.fail(new Error(`Machine ${id} cannot stop from ${machine.status}`))
            }

            save("stopping")

            const exec = createExecFileExecutor()

            try {
              yield* Effect.tryPromise(() => terminateWslMachine(exec, machine))
            } catch (error) {
              // A failed terminate must not leak the keep-alive: it would
              // keep the distro alive in the background with no record of it.
              wslProcesses.get(id)?.kill()
              wslProcesses.delete(id)
              save("error")

              return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
            }

            wslProcesses.get(id)?.kill()
            wslProcesses.delete(id)

            return save("stopped")
          }

          if (machine.backend === "apple-vz") {
            if (machine.status !== "running" && machine.status !== "starting") {
              return yield* Effect.fail(new Error(`Machine ${id} cannot stop from ${machine.status}`))
            }

            save("stopping")

            const process = appleVzProcesses.get(id)

            if (!process) {
              save("error")

              return yield* Effect.fail(
                new Error(`Machine ${id} has no tracked Apple Vz helper process to kill`),
              )
            }

            process.kill()
            appleVzProcesses.delete(id)

            return save("stopped")
          }

          if (machine.backend !== "container") {
            return yield* Effect.fail(new Error(`Machine ${id} backend ${machine.backend} cannot stop yet`))
          }

          if (machine.status !== "running" && machine.status !== "starting") {
            return yield* Effect.fail(new Error(`Machine ${id} cannot stop from ${machine.status}`))
          }

          save("stopping")

          const exec = createExecFileExecutor()

          try {
            const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

            yield* Effect.tryPromise(() => stopContainer(exec, runtime, machine))
          } catch (error) {
            save("error")

            return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
          }

          return save("stopped")
        }),
      MachinesSnapshot: ({ id }) =>
        Effect.gen(function* () {
          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend !== "container") {
            return yield* Effect.fail(new Error(`Machine ${id} backend ${machine.backend} cannot snapshot yet`))
          }

          if (machine.status !== "running" && machine.status !== "stopped") {
            return yield* Effect.fail(new Error(`Machine ${id} cannot snapshot from ${machine.status}`))
          }

          const snapshotId = `snap_${Date.now().toString(36)}`
          const exec = createExecFileExecutor()

          try {
            const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

            yield* Effect.tryPromise(() => snapshotContainer(exec, runtime, machine, snapshotId))
          } catch (error) {
            return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
          }

          const current = storage.state.items(namespace).items
          const snapshotted = setMachineSnapshot(current, id, snapshotId)

          storage.state.update(namespace, { [id]: JSON.stringify(snapshotted.machine) }, [])

          return snapshotted.machine
        }),
      MachinesExec: ({ id, command }) =>
        Effect.gen(function* () {
          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend !== "container") {
            return yield* Effect.fail(new Error(`Machine ${id} backend ${machine.backend} cannot exec yet`))
          }

          if (machine.status !== "running") {
            return yield* Effect.fail(new Error(`Machine ${id} cannot exec from ${machine.status}`))
          }

          if (command.length === 0) {
            return yield* Effect.fail(new Error("Exec command is empty"))
          }

          const exec = createExecFileExecutor()
          const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

          return yield* Effect.tryPromise(() => execInContainer(exec, runtime, machine, command))
        }),
      MachinesLogs: ({ id }) =>
        Effect.gen(function* () {
          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend !== "container") {
            return yield* Effect.fail(new Error(`Machine ${id} backend ${machine.backend} cannot show logs yet`))
          }

          const exec = createExecFileExecutor()
          const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

          return yield* Effect.tryPromise(() => logsContainer(exec, runtime, machine))
        }),
      MachinesNetwork: ({ id, network }) =>
        Effect.gen(function* () {
          const raw = storage.state.items(namespace).items[id]

          if (!raw) return yield* Effect.fail(new Error(`Machine ${id} not found`))

          const machine = parseMachine(raw)

          if (machine.backend !== "container") {
            return yield* Effect.fail(
              new Error(`Machine ${id} backend ${machine.backend} cannot toggle network yet`),
            )
          }

          if (machine.status !== "running") {
            return yield* Effect.fail(new Error(`Machine ${id} cannot toggle network from ${machine.status}`))
          }

          // Already in the requested state: no runtime call, no failure
          // from a redundant connect/disconnect.
          if (machine.network === network) return machine

          const exec = createExecFileExecutor()

          try {
            const runtime = yield* Effect.tryPromise(() => detectContainerRuntime(exec))

            yield* Effect.tryPromise(() => setContainerNetwork(exec, runtime, machine, network))
          } catch (error) {
            return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
          }

          const current = storage.state.items(namespace).items
          const updated = setMachineNetwork(current, id, network)

          storage.state.update(namespace, { [id]: JSON.stringify(updated.machine) }, [])

          return updated.machine
        }),
    })
  }),
)

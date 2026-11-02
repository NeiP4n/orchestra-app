import { Effect } from "effect"
import { MachineRpcs } from "../../shared/ipc-rpc/machines"
import { DesktopStorage } from "../storage"
import {
  createExecFileExecutor,
  detectContainerRuntime,
  startContainer,
  stopContainer,
} from "../machines/runner"
import { createMachine, deleteMachine, listMachines, parseMachine, updateMachineStatus } from "../machines/store"

const namespace = "machines"

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
        Effect.sync(() => {
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

            yield* Effect.tryPromise(() => startContainer(exec, runtime, machine))
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
    })
  }),
)

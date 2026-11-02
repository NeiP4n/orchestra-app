import { Effect } from "effect"
import { MachineRpcs } from "../../shared/ipc-rpc/machines"
import { DesktopStorage } from "../storage"
import { createMachine, deleteMachine, listMachines, updateMachineStatus } from "../machines/store"

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
    })
  }),
)

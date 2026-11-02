import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const MachineBackendSchema = Schema.Literal("firecracker", "qemu-kvm", "apple-vz", "wsl", "container")

export const MachineStatusSchema = Schema.Literal(
  "creating",
  "stopped",
  "starting",
  "running",
  "stopping",
  "error",
  "destroying",
)

export const MachineSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  backend: MachineBackendSchema,
  cpu: Schema.Number,
  memoryMb: Schema.Number,
  diskGb: Schema.Number,
  network: Schema.Boolean,
  status: MachineStatusSchema,
  snapshotId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})

export const MachinesList = Rpc.make("MachinesList", {
  success: Schema.Array(MachineSchema),
})

export const MachinesCreate = Rpc.make("MachinesCreate", {
  payload: {
    name: Schema.String,
    backend: MachineBackendSchema,
    cpu: Schema.Number,
    memoryMb: Schema.Number,
    diskGb: Schema.Number,
    network: Schema.Boolean,
  },
  success: MachineSchema,
})

export const MachinesUpdateStatus = Rpc.make("MachinesUpdateStatus", {
  payload: { id: Schema.String, status: MachineStatusSchema },
  success: MachineSchema,
})

export const MachinesDelete = Rpc.make("MachinesDelete", {
  payload: { id: Schema.String },
})

export const MachinesStart = Rpc.make("MachinesStart", {
  payload: { id: Schema.String },
  success: MachineSchema,
})

export const MachinesStop = Rpc.make("MachinesStop", {
  payload: { id: Schema.String },
  success: MachineSchema,
})

export const MachinesSnapshot = Rpc.make("MachinesSnapshot", {
  payload: { id: Schema.String },
  success: MachineSchema,
})

export const MachinesExec = Rpc.make("MachinesExec", {
  payload: { id: Schema.String, command: Schema.Array(Schema.String) },
  success: Schema.Struct({ stdout: Schema.String, exitCode: Schema.Number }),
})

export const MachinesLogs = Rpc.make("MachinesLogs", {
  payload: { id: Schema.String },
  success: Schema.Struct({ stdout: Schema.String, exitCode: Schema.Number }),
})

export const MachineRpcs = RpcGroup.make(
  MachinesList,
  MachinesCreate,
  MachinesUpdateStatus,
  MachinesDelete,
  MachinesStart,
  MachinesStop,
  MachinesSnapshot,
  MachinesExec,
  MachinesLogs,
)

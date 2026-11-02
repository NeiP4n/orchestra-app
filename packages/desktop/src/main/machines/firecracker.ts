// Firecracker microVM configuration builder (Linux/KVM only).
// Firecracker exposes a REST API over a Unix socket; a VM is configured
// with PUT /machine-config, PUT /boot-source, PUT /drives/rootfs, an
// optional PUT /network-interfaces/eth0, then PUT /actions InstanceStart.
// This module builds those requests only. It does not spawn Firecracker:
// a real start also needs /dev/kvm, a guest kernel image and an ext4
// rootfs image, none of which this repository ships, and Firecracker has
// no built-in exec mechanism, so agent commands inside the guest still
// need vsock/ssh. The IPC layer must keep refusing firecracker starts
// until those assets are configured, instead of pretending a VM booted.

import type { Machine } from "./store"

export type FirecrackerApiBody =
  | { vcpu_count: number; mem_size_mib: number }
  | { kernel_image_path: string; boot_args: string }
  | { drive_id: string; path_on_host: string; is_root_device: boolean; is_read_only: boolean }
  | { iface_id: string; host_dev_name: string; guest_mac: string }
  | { action_type: "InstanceStart" }

export interface FirecrackerApiRequest {
  method: "PUT"
  path: string
  body: FirecrackerApiBody
}

export interface FirecrackerAssets {
  kernelImagePath: string
  rootfsPath: string
  bootArgs?: string
  network?: {
    hostDevName: string
    guestMac: string
  }
}

export function firecrackerSocketPath(machineId: string): string {
  return `/tmp/orchestra-machine-${machineId.replace(/[^a-zA-Z0-9_-]/g, "-")}.socket`
}

export function firecrackerProcessCommand(binary: string, machine: Machine): string[] {
  return [binary, "--api-sock", firecrackerSocketPath(machine.id)]
}

export function firecrackerApiRequests(machine: Machine, assets: FirecrackerAssets): FirecrackerApiRequest[] {
  if (!assets.kernelImagePath || !assets.rootfsPath) {
    throw new Error("Firecracker start needs a kernel image and a rootfs image")
  }

  const requests: FirecrackerApiRequest[] = [
    {
      method: "PUT",
      path: "/machine-config",
      body: { vcpu_count: machine.cpu, mem_size_mib: machine.memoryMb },
    },
    {
      method: "PUT",
      path: "/boot-source",
      body: {
        kernel_image_path: assets.kernelImagePath,
        boot_args: assets.bootArgs ?? "console=ttyS0 reboot=k panic=1 pci=off",
      },
    },
    {
      method: "PUT",
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: assets.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    },
  ]

  if (machine.network && assets.network) {
    requests.push({
      method: "PUT",
      path: "/network-interfaces/eth0",
      body: {
        iface_id: "eth0",
        host_dev_name: assets.network.hostDevName,
        guest_mac: assets.network.guestMac,
      },
    })
  }

  requests.push({
    method: "PUT",
    path: "/actions",
    body: { action_type: "InstanceStart" },
  })

  return requests
}

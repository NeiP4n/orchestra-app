import { describe, expect, test } from "bun:test"
import { firecrackerApiRequests, firecrackerProcessCommand, firecrackerSocketPath } from "./firecracker"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "firecracker",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("firecracker configuration builder", () => {
  test("builds machine-config, boot-source, rootfs and InstanceStart in order", () => {
    const requests = firecrackerApiRequests(machine, {
      kernelImagePath: "/var/lib/orchestra/vmlinux",
      rootfsPath: "/var/lib/orchestra/rootfs.ext4",
    })

    expect(requests.map((request) => request.path)).toEqual([
      "/machine-config",
      "/boot-source",
      "/drives/rootfs",
      "/actions",
    ])
    expect(requests[0].body).toEqual({ vcpu_count: 2, mem_size_mib: 2048 })
    expect(requests[1].body).toEqual({
      kernel_image_path: "/var/lib/orchestra/vmlinux",
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
    })
    expect(requests[2].body).toEqual({
      drive_id: "rootfs",
      path_on_host: "/var/lib/orchestra/rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
    })
    expect(requests[3].body).toEqual({ action_type: "InstanceStart" })
  })

  test("adds a network interface only when the machine wants networking", () => {
    const networked = firecrackerApiRequests(
      { ...machine, network: true },
      {
        kernelImagePath: "/var/lib/orchestra/vmlinux",
        rootfsPath: "/var/lib/orchestra/rootfs.ext4",
        network: { hostDevName: "tap-m1", guestMac: "AA:FC:00:00:00:01" },
      },
    )

    expect(networked.map((request) => request.path)).toContain("/network-interfaces/eth0")
    expect(firecrackerApiRequests(machine, {
      kernelImagePath: "/var/lib/orchestra/vmlinux",
      rootfsPath: "/var/lib/orchestra/rootfs.ext4",
      network: { hostDevName: "tap-m1", guestMac: "AA:FC:00:00:00:01" },
    }).map((request) => request.path)).not.toContain("/network-interfaces/eth0")
  })

  test("socket path is sanitized and missing assets fail", () => {
    expect(firecrackerSocketPath("m/1")).toBe("/tmp/orchestra-machine-m-1.socket")
    expect(firecrackerProcessCommand("firecracker", machine)).toEqual([
      "firecracker",
      "--api-sock",
      "/tmp/orchestra-machine-m1.socket",
    ])
    expect(() => firecrackerApiRequests(machine, { kernelImagePath: "", rootfsPath: "" })).toThrow()
  })
})

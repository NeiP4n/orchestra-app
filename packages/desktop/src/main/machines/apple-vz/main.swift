// orchestra-vz: native helper for Apple Virtualization.framework.
// Built on macOS with: swiftc -O main.swift -o orchestra-vz
// The desktop main process invokes it (see apple-vz.ts) with:
//   orchestra-vz start --id <id> --cpu <n> --memory <mb> --kernel <path> --disk <path>
//   orchestra-vz stop --id <id>
//   orchestra-vz status --id <id>
// "start" runs the VM in the foreground until it stops or is killed;
// the desktop process owns the helper process, so killing the helper
// stops the VM. "stop" and "status" are intentionally unimplemented
// here: a single helper process cannot control a VM owned by another
// process without a shared control socket, which is not shipped yet.
// The desktop side must therefore stop a VM by killing its helper
// process, and must treat a live helper process as "running".
// This file is source only: it has not been compiled, because this
// environment has no macOS or Swift toolchain.

import Foundation
import Virtualization

enum VzError: Error {
    case missingArgument(String)
    case invalidValue(String)
    case configurationFailed(String)
}

func arguments() -> [String: String] {
    var result: [String: String] = [:]
    var args = CommandLine.arguments.dropFirst()
    while let flag = args.first {
        args = args.dropFirst()
        guard flag.hasPrefix("--"), let value = args.first else { continue }
        args = args.dropFirst()
        result[String(flag.dropFirst(2))] = value
    }
    return result
}

func runStart() throws {
    let args = arguments()
    guard let kernelPath = args["kernel"] else { throw VzError.missingArgument("kernel") }
    guard let diskPath = args["disk"] else { throw VzError.missingArgument("disk") }
    guard let cpuString = args["cpu"], let cpuCount = Int(cpuString) else { throw VzError.invalidValue("cpu") }
    guard let memoryString = args["memory"], let memoryMb = UInt64(memoryString) else { throw VzError.invalidValue("memory") }

    let config = VZVirtualMachineConfiguration()

    let cpu = VZCPUConfiguration()
    cpu.cpuCount = cpuCount
    config.cpu = cpu

    let memory = VZMemoryConfiguration()
    memory.size = memoryMb * 1024 * 1024
    config.memory = memory

    config.bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernelPath))

    let diskAttachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: diskPath), readOnly: false)
    let disk = VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
    config.storageDevices = [disk]

    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    config.networkDevices = [network]

    config.platform = VZGenericPlatformConfiguration()

    try config.validate()

    let machine = VZVirtualMachine(configuration: config)
    let semaphore = DispatchSemaphore(value: 0)
    machine.start { result in
        if case .failure(let error) = result {
            fputs("orchestra-vz: start failed: \(error)\n", stderr)
            exit(1)
        }
    }
    // Wait until the process is killed; the VM runs on its own threads.
    _ = semaphore.wait(timeout: .distantFuture)
}

let command = CommandLine.arguments.dropFirst().first
do {
    switch command {
    case "start":
        try runStart()
    case "stop", "status":
        fputs("orchestra-vz: \(command ?? "") is not implemented; stop by killing the helper process\n", stderr)
        exit(2)
    default:
        fputs("orchestra-vz: usage: start|stop|status\n", stderr)
        exit(2)
    }
} catch {
    fputs("orchestra-vz: \(error)\n", stderr)
    exit(1)
}

#!/usr/bin/env bun
/**
 * Universal System Integrity: L0-L6 Layer Dependency Auditor
 *
 * Enforces Clean Architecture invariants across the Orchestra monorepo:
 * - Dependencies flow strictly downwards:
 *   Surface (L6) -> Transport (L5) -> Domain (L4) -> Plugins (L3) -> Client (L2) -> Contract (L1) -> Leaf (L0)
 * - Layer 0 (packages/schema, packages/util, etc.): Zero internal runtime dependencies.
 * - Layer 1 (packages/protocol, packages/ai): Only depends on L0.
 * - Layer 2 (packages/client): Generated clients. Must NEVER import from Core (L4) or Server (L5).
 * - Layer 3 (packages/plugin, packages/latex, packages/merman, packages/plugin-browser): Plugin host & plugins.
 * - Layer 4 (packages/core): Domain execution engine. Cannot depend on Server (L5) or Surface (L6).
 * - Layer 5 (packages/server): Transport layer. Mounts Protocol (L1) and executes Core (L4).
 * - Layer 6 (packages/cli, packages/tui, etc.): Presentation surfaces.
 */

import fs from "fs"
import path from "path"

export interface LayerDefinition {
  readonly [dir: string]: number
}

export const MONOREPO_LAYERS: LayerDefinition = {
  // L0 - Foundation & Pure Schemas
  "packages/schema": 0,
  "packages/util": 0,
  "packages/codemode": 0,
  "packages/theme": 0,
  "packages/ui": 0,
  "packages/http-recorder": 0,
  "packages/httpapi-codegen": 0,
  "packages/web": 0,
  "packages/script": 0,
  "packages/function": 0,
  "packages/posts": 0,

  // L1 - Protocols, Domain Models & AI Engine
  "packages/protocol": 1,
  "packages/ai": 1,

  // L2 - Client Adapters & Automation
  "packages/client": 2,

  // L3 - Plugins & Extensibility (Plugin host & specific plugins)
  "packages/plugin": 3,
  "packages/plugin-browser": 3,
  "packages/latex": 3,
  "packages/merman": 3,
  "services/idea-bank": 3,
  "services/files": 3,

  // L4 - Core Business Logic & Orchestration
  "packages/core": 4,
  "packages/simulation": 4,
  "packages/kernel": 4,

  // L5 - Transport & Remote APIs
  "packages/server": 5,
  "packages/session-ui": 5,
  "services/update": 5,
  "services/www": 5,

  // L6 - Presentation & Surfaces
  "packages/cli": 6,
  "packages/tui": 6,
  "packages/app": 6,
  "packages/desktop": 6,
  "packages/sdk": 6,
  "packages/enterprise": 6,
  "packages/gui-extensions": 6,
  "packages/storybook": 6,
}

export interface LayerViolation {
  readonly fromPackage: string
  readonly fromLayer: number
  readonly toPackage: string
  readonly toLayer: number
  readonly dependencyName: string
  readonly rule: string
}

export function auditMonorepoLayers(rootDir: string = process.cwd()): {
  totalAudited: number
  violations: LayerViolation[]
} {
  const packageNameToDir: Record<string, string> = {}
  const violations: LayerViolation[] = []

  // 1. Build map of package name -> directory
  for (const dir of Object.keys(MONOREPO_LAYERS)) {
    const pkgJsonPath = path.join(rootDir, dir, "package.json")
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
        if (pkg.name) {
          packageNameToDir[pkg.name] = dir
        }
      } catch (err) {
        console.warn(`[audit-layers] Failed to parse ${pkgJsonPath}: ${err}`)
      }
    }
  }

  let auditedCount = 0

  // 2. Audit runtime dependencies in package.json
  for (const [dir, layer] of Object.entries(MONOREPO_LAYERS)) {
    const pkgJsonPath = path.join(rootDir, dir, "package.json")
    if (!fs.existsSync(pkgJsonPath)) continue

    auditedCount++
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
    const runtimeDeps = pkg.dependencies || {}

    for (const depName of Object.keys(runtimeDeps)) {
      const depDir = packageNameToDir[depName]
      if (depDir !== undefined) {
        const depLayer = MONOREPO_LAYERS[depDir]

        // Rule 1: General downward flow for runtime dependencies (depLayer <= layer)
        if (depLayer > layer) {
          violations.push({
            fromPackage: dir,
            fromLayer: layer,
            toPackage: depDir,
            toLayer: depLayer,
            dependencyName: depName,
            rule: `Layer L${layer} cannot depend on higher Layer L${depLayer} (${depName})`,
          })
        }

        // Rule 2: Client runtime code (packages/client) must never import from Core or Server
        if (dir === "packages/client" && (depDir === "packages/core" || depDir === "packages/server")) {
          violations.push({
            fromPackage: dir,
            fromLayer: layer,
            toPackage: depDir,
            toLayer: depLayer,
            dependencyName: depName,
            rule: "Client runtime code (@orchestra/client) must NEVER depend on Core or Server",
          })
        }

        // Rule 3: Schema (packages/schema) must have 0 dependencies on internal packages
        if (dir === "packages/schema" && depDir !== "packages/schema") {
          violations.push({
            fromPackage: dir,
            fromLayer: layer,
            toPackage: depDir,
            toLayer: depLayer,
            dependencyName: depName,
            rule: "Schema (L0) must have zero dependencies on other internal packages",
          })
        }
      }
    }

    // 3. Audit source code imports in packages/client/src to guarantee no direct leakage
    if (dir === "packages/client") {
      const clientSrc = path.join(rootDir, "packages/client/src")
      if (fs.existsSync(clientSrc)) {
        const scanSource = (curDir: string) => {
          const entries = fs.readdirSync(curDir, { withFileTypes: true })
          for (const ent of entries) {
            const full = path.join(curDir, ent.name)
            if (ent.isDirectory()) {
              scanSource(full)
            } else if (ent.isFile() && /\.(ts|tsx|js|mjs)$/.test(ent.name)) {
              const srcContent = fs.readFileSync(full, "utf8")
              if (srcContent.includes("@orchestra/core") || srcContent.includes("@orchestra/server")) {
                violations.push({
                  fromPackage: path.relative(rootDir, full),
                  fromLayer: 2,
                  toPackage: "core/server",
                  toLayer: 4,
                  dependencyName: "@orchestra/core or @orchestra/server",
                  rule: "Forbidden import of Core or Server inside packages/client/src",
                })
              }
            }
          }
        }
        scanSource(clientSrc)
      }
    }
  }

  return {
    totalAudited: auditedCount,
    violations,
  }
}

// --------------------------------------------------------------------------
// Main CLI Execution
// --------------------------------------------------------------------------
if (import.meta.main) {
  console.log("Auditing Clean Architecture layers L0-L6...")
  const result = auditMonorepoLayers()

  if (result.violations.length > 0) {
    console.error(`\n[LAYER INTEGRITY FAILURE] Found ${result.violations.length} layer violations:\n`)
    for (const v of result.violations) {
      console.error(`  - ${v.fromPackage} (L${v.fromLayer}) -> ${v.toPackage} (L${v.toLayer})`)
      console.error(`    Dependency: ${v.dependencyName}`)
      console.error(`    Rule:       ${v.rule}\n`)
    }
    process.exit(1)
  }

  console.log(
    `[dependency-auditor] PASS: Successfully verified integrity of ${result.totalAudited} packages across L0-L6 layers. Zero layer violations detected.`,
  )
  process.exit(0)
}

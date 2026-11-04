import type { Plugin } from "@orchestra/plugin/tui"

// Builtins are visible to configuration by id, but their implementations need not all be
// imported at startup. A builtin excluded by configuration stays out of the runtime heap.
type Loader = () => Promise<{ default: Plugin.Definition }>

function lazy(id: string, load: Loader): Plugin.Definition {
  let definition: Promise<Plugin.Definition> | undefined
  return {
    id,
    setup(context) {
      if (!definition) {
        definition = load()
          .then((module) => {
            if (module.default.id !== id)
              throw new Error(`Builtin plugin id mismatch: expected ${id}, got ${module.default.id}`)
            return module.default
          })
          .catch((error) => {
            definition = undefined
            throw error
          })
      }
      return definition.then((plugin) => plugin.setup(context))
    },
  }
}

export const builtins = [
  lazy("orchestra.home.footer", () => import("../feature-plugins/home/footer")),
  lazy("orchestra.btw", () => import("../feature-plugins/prompt/btw")),
  lazy("orchestra.prompt.footer", () => import("../feature-plugins/prompt/footer")),
  lazy("orchestra.mascot", () => import("../feature-plugins/prompt/mascot")),
  lazy("orchestra.sidebar.context", () => import("../feature-plugins/sidebar/context")),
  lazy("orchestra.sidebar.mcp", () => import("../feature-plugins/sidebar/mcp")),
  lazy("orchestra.sidebar.footer", () => import("../feature-plugins/sidebar/footer")),
  lazy("orchestra.notifications", () => import("../feature-plugins/system/notifications")),
  lazy("orchestra.plugins", () => import("../feature-plugins/system/plugins")),
  lazy("orchestra.stats", () => import("../feature-plugins/system/stats")),
  lazy("orchestra.branch", () => import("../feature-plugins/system/branch")),
  lazy("orchestra.merman", () => import("@orchestra/merman/plugin")),
  lazy("orchestra.latex", () => import("@orchestra/latex/plugin")),
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for ORCHESTRA_STORY runs.
  ...(process.env.ORCHESTRA_STORY ? [lazy("orchestra.storybook", () => import("../feature-plugins/system/storybook"))] : []),
  lazy("orchestra.diffs", () => import("../feature-plugins/system/diff-viewer")),
  lazy("orchestra.freebuff", () => import("../feature-plugins/system/freebuff")),
]

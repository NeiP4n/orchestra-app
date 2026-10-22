import { Plugin, PluginContextProvider, usePlugin } from "@orchestra/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({
  additional: {
    "@orchestra/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})

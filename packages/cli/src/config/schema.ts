import { Config } from "@orchestra/tui/config"
import { Schema } from "effect"

export const SchemaURL = "https://raw.githubusercontent.com/NeiP4n/orchestra-app/v2/packages/cli/schema.json"

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({ description: "JSON Schema for CLI configuration" }),
  ...Config.Info.fields,
})
export type Info = Schema.Schema.Type<typeof Info>

export function normalizeLegacyTabs(info: Info | undefined) {
  if (info?.tabs?.enabled === undefined) return info
  const tabs = { ...info.tabs }
  tabs.mode ??= tabs.enabled ? "on" : "off"
  delete tabs.enabled
  return { ...info, tabs }
}

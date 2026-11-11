/** Fail-closed runtime gate. Operator-disabled configuration is never an acquisition hint. */
export function mcpMayStart(
  config: { readonly disabled?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ORCHESTRA_MCP === "1" && config.disabled !== true
}

/** Agent text/approved:true is not an operator enable grant. Use the operator registry UI. */
export function operatorEnableRequest(kind: "MCP server" | "plugin", target: string): string {
  return `${kind} "${target}" remains disabled. Operator approval required: ask the operator to enable it in the Registry. No configuration was changed and no connection was attempted.`
}

# Stops the MCP server processes Orchestra left behind (node, npx, python/uv chains), except those that belong
# to the Claude app. Run it once with Orchestra closed; the service now clears its own leftovers on start.
$all = Get-CimInstance Win32_Process
$byId = @{}; $all | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }
function UnderClaude($p) {
  $cur = $p; $depth = 0
  while ($cur -and $depth -lt 40) {
    if ($cur.Name -match '^claude') { return $true }
    $cur = $byId[[int]$cur.ParentProcessId]; $depth++
  }
  return $false
}
$signature = 'modelcontextprotocol|wonderwhy-er|upstash.context7|playwright.mcp|chrome-devtools-mcp|rea-agents|rea_agents|android_helper\.mjs|uv\cache\archive|server-sequential|server-memory|mcp-server-|windows-mcp'
$targets = $all | Where-Object { ($_.Name -in 'node.exe', 'python.exe', 'uv.exe', 'uvx.exe' -or $_.Name -match '^(mcp-server-|windows-mcp)') -and $_.CommandLine -match $signature -and -not (UnderClaude $_) }
"Stopping $($targets.Count) MCP processes"
$targets | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
$os = Get-CimInstance Win32_OperatingSystem
"Free memory now: {0} MB physical, {1} MB virtual" -f [int]($os.FreePhysicalMemory / 1024), [int]($os.FreeVirtualMemory / 1024)

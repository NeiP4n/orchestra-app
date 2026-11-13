import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "../src/shell/parse.js"
import { Wildcard } from "../src/util/wildcard.js"

describe("native shell syntax compatibility", () => {
  test("PowerShell invocation approvals include the operator instead of saving an ineffective prefix", async () => {
    const command = "& $Command value"
    expect(await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace"))).toEqual({
      commands: [{ resource: command, save: "$Command *" }],
      directories: [],
    })
    expect(await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace", { portable: true }))).toEqual({
      commands: [{ resource: command, save: "& $Command *" }],
      directories: [],
    })
  })

  test.each([
    "ForEach-Object { Write-Output value }",
    "Write-Output before; ForEach-Object { Write-Output value }",
    "ForEach-Object { Write-Output value } | Write-Output done",
    "Write-Output before | ForEach-Object { Write-Output $_ }",
    "& ForEach-Object { Write-Output value }",
    "& 'ForEach-Object' { Write-Output value }",
    "% { Write-Output value }",
    "Where-Object { Write-Output value }",
  ])("PowerShell scriptblock callers preserve permission resources and usable approvals: %s", async (command) => {
    const legacy = await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace"))
    const native = await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace", { portable: true }))
    expect(native.commands.map((item) => item.resource)).toEqual(legacy.commands.map((item) => item.resource))
    for (const item of native.commands) expect(Wildcard.match(item.resource, item.save), item.resource).toBe(true)
  })

  for (const shell of ["bash", "zsh"]) {
    test.each([
      "cat <<'EOF'\n$(not_a_command)\nEOF",
      "cat <<EOF\n$(printf hello)\nEOF",
      "cat <<-EOF\n\thello\n\tEOF",
      "cat <<EOF\nhello\nEOF\nprintf done",
      'cat <<< "$(printf hello)"',
      "for file in a b; do printf '%s' \"$file\"; done",
      "for file in $(printf file); do printf '%s' \"$file\"; done",
      'for file in a b; do if test -n "$file"; then printf \'%s\' "$file"; fi; done',
      "while IFS= read -r file; do printf '%s' \"$file\"; done < input",
      "until test -f ready; do sleep 1; done",
      "if true; then if false; then printf no; else printf yes; fi; fi",
      "if true; then :; X=$(printf value); fi",
      'case "$target" in *.ts) printf typescript;; *) printf other;; esac',
      "greet() { printf hello; }; greet",
      "function greet { printf hello; }; greet",
      "printf before; { printf grouped; }; (printf subshell)",
      "time git status",
      "time -p git status",
      "coproc git status",
      "if [[ -f file ]]; then cat file; fi",
      "[[ $(printf yes) = yes ]]",
      "echo ${value:-default}",
      'echo "${value:-$(printf fallback)}"',
      "echo ${value//before/after}",
      "echo ${arr[$(printf index)]}",
      "printf '%s' $'line1\\nline2'",
      'printf "%s" $"hello"',
      "echo $((1 + ${value:-2}))",
      "echo $((array[$(printf 0)]))",
      "echo $[1 + 2]",
      "((count++))",
      "for ((i=0; i<2; i++)); do printf ok; done",
      "echo `printf \\2`",
    ])(`${shell} extracts commands without rejecting ordinary syntax: %s`, async (command) => {
      const legacy = await Effect.runPromise(ShellParse.scan(command, shell, "/workspace"))
      const native = await Effect.runPromise(ShellParse.scan(command, shell, "/workspace", { portable: true }))
      expect(native).toEqual(legacy)
      expect(await Effect.runPromise(ShellParse.scanPortable(command, shell, "/workspace"))).toEqual(native)
    })
  }

  test("does not invent commands from a quoted second heredoc body", async () => {
    const command = "cat <<FIRST <<'SECOND'\n$(printf first)\nFIRST\n$(not_a_command)\nSECOND"
    const expected = {
      commands: [
        { resource: command, save: "cat *" },
        { resource: "printf first", save: "printf *" },
      ],
      directories: [],
    }
    expect(await Effect.runPromise(ShellParse.scanPortable(command, "bash", "/workspace"))).toEqual(expected)
    expect(await Effect.runPromise(ShellParse.scan(command, "bash", "/workspace", { portable: true }))).toEqual(
      expected,
    )
  })

  test.each([
    'Write-Output "$(Get-Location)"',
    "$value = Get-Date; Write-Output $value",
    "if ($true) { Write-Output yes } else { Write-Output no }",
    "if (Test-Path file) { Get-Item file }",
    "foreach ($value in @('a','b')) { Write-Output $value }",
    "for ($i=0; $i -lt 2; $i++) { Write-Output $i }",
    "while (Test-Path file) { Get-Item file; break }",
    "function Show-Value { Write-Output value }; Show-Value",
    "Get-Item -Path (Join-Path src file)",
    'Write-Output "line1`nline2"',
    "Write-Output `\n  continued",
    "<# comment #> Write-Output done",
    "Write-Output @'\nhello\n'@",
    "git st`atus",
  ])("PowerShell extracts commands without rejecting ordinary syntax: %s", async (command) => {
    const legacy = await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace"))
    const native = await Effect.runPromise(ShellParse.scan(command, "pwsh", "/workspace", { portable: true }))
    expect(native).toEqual(legacy)
    expect(await Effect.runPromise(ShellParse.scanPortable(command, "pwsh", "/workspace"))).toEqual(native)
  })
})

test("reported UTF-8 python and literal JS here-string parse without loosening invalid quotes",async()=>{
 const python=`python -c "import sys; sys.stdout.reconfigure(encoding='utf-8'); print('Тест русского текста: Успешно')"`
 const script=`$code = @'  \nconst fs = require("fs"); const object = {"$schema":"local.json"};\nconsole.log(object);\n'@\nnode -e $code`.replaceAll("\\n","\n")
 for(const shell of ["pwsh","powershell.exe","C:\\Program Files\\PowerShell\\7\\pwsh.exe"]){
  const a=await Effect.runPromise(ShellParse.scanPortable(python,shell,"C:/project"))
  expect(a.commands[0]?.resource).toBe(python)
  const c=await Effect.runPromise(ShellParse.scanPortable(script,shell,"C:/project"))
  expect(c.commands.some(item=>item.resource==="node -e $code")).toBe(true)
 }
 const invalid=`node -e "const ids = code.split('\\n').filter(l => l.includes('id: \\\"')).map(l => l.trim()); console.log(ids);"`
 await expect(Effect.runPromise(ShellParse.scanPortable(invalid,"pwsh","C:/project"))).rejects.toThrow("PowerShell does not escape a quote with backslash")
 await expect(Effect.runPromise(ShellParse.scanPortable('Write-Output "unclosed',"pwsh","C:/project"))).rejects.toThrow("unterminated-quote")
})

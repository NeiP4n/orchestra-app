import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { securitySettings } from "../src/util/security-settings"
test("security inventory derives real local limits and never prints secret environment values",()=>{
  const rows=securitySettings({ORCHESTRA_GATEWAY_TOKEN:"SECRET-GATEWAY",ORCHESTRA_BROWSER_PROFILE:"SECRET-PATH",ORCHESTRA_DRAIN_WALL_CLOCK_MS:"9000",ORCHESTRA_BROWSER_MAX:"4",ORCHESTRA_DISABLE_LIMITS:"1",ORCHESTRA_MCP:"SECRET-INJECTION"})
  expect(rows.find(r=>r.id==="limits")?.value).toBe("включена")
  expect(rows.find(r=>r.id==="browsers")?.value).toBe("4")
  expect(rows.find(r=>r.id==="wall")?.value).toBe("9000 мс")
  expect(JSON.stringify(rows)).not.toContain("SECRET-")
  expect(rows.find(r=>r.id==="money")?.value).toContain("не подтверждён")
  expect(rows.find(r=>r.id==="js")?.value).toContain("нет общего")
  expect(rows.find(r=>r.id==="pty")?.value).toContain("не подключён")
})
test("security rows are retain secret boundaries while autoaccept arrow is immediate",()=>{
  const source=readFileSync(new URL("../src/component/dialog-config.tsx",import.meta.url),"utf8")
  expect(source).toContain('category: "Безопасность"')
  expect(source).toContain('<DialogSecurity />')
  expect(source).not.toContain('Расширить права сессий?')
  expect(source).not.toContain('РАЗРЕШИТЬ')
  expect(source).toContain('return write(next, index)')
  expect(source).toContain('compact')
})

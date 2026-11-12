import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

test("unloaded startup empty does not erase disk, but authoritative deletion clears immediately and survives restart", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-projection-"))
  const env = { ...process.env, ORCHESTRA_DATA_DIR: root, ORCHESTRA_STATE_DIR: root, ORCHESTRA_CONFIG_DIR: root, ORCHESTRA_CACHE_DIR: root }
  const run = (script: string) => spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(import.meta.dir, ".."), env, encoding: "utf8", timeout: 15_000,
  })
  try {
    const first = run(`
      import {BrowserRuntime as R} from './src/browser/runtime';
      import {readFileSync} from 'node:fs';
      R.publishSessions([{id:'brw_one',name:'Browser 1',project:'/own',projectID:'prj_own',chat:'ses_one'}]);
      R.publishSessions([]);
      if(JSON.parse(readFileSync(R.sessionsFilePath(),'utf8')).length!==1)throw Error('startup protection lost');
      R.publishSessions([], {authoritative:true});
      if(readFileSync(R.sessionsFilePath(),'utf8')!=='[]')throw Error('deleted browser still published');
      console.log('CLEARED');
    `)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain("CLEARED")
    const restart = run(`
      import {BrowserRuntime as R} from './src/browser/runtime';
      import {readFileSync} from 'node:fs';
      if(readFileSync(R.sessionsFilePath(),'utf8')!=='[]'||R.sessions().length)throw Error('resurrected');
      console.log('EMPTY');
    `)
    expect(restart.status, restart.stderr).toBe(0)
    expect(restart.stdout).toContain("EMPTY")
  } finally { rmSync(root, {recursive: true, force: true}) }
})

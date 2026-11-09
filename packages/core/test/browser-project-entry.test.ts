import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

test("real perform entrypoint rejects foreign project for read, write, start and stop before touching Chrome", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestra-browser-owner-"))
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import {BrowserRuntime as R} from './src/browser/runtime';
      import {perform} from './src/tool/plugin/browser';
      R.publishSessions([{id:'brw_foreign',name:'Foreign',project:'/foreign',projectID:'prj_foreign'}]);
      let count=0;
      for(const action of ['text','cookies','storage','eval','type','click','start','stop']){
        try{await perform('brw_foreign',{action},false,{directory:'/own',projectID:'prj_own'});throw new Error('unexpected grant')}
        catch(error){if(!String(error).includes('another project'))throw error;count++}
      }
      console.log('DENIED '+count);
    `], {
      cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8",
      env: { ...process.env, ORCHESTRA_DATA_DIR:root, ORCHESTRA_STATE_DIR:root, ORCHESTRA_CONFIG_DIR:root, ORCHESTRA_CACHE_DIR:root },
      timeout: 15_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("DENIED 8")
    expect(existsSync(path.join(root,"browser-profiles","brw_foreign"))).toBe(false)
  } finally { rmSync(root, { recursive:true, force:true }) }
})

test("actual model plugin denies foreign actions before permission and hides foreign sessions", () => {
  const root=mkdtempSync(path.join(tmpdir(),"orchestra-browser-plugin-owner-"))
  try {
    const result=spawnSync(process.execPath,["-e",`
      import {Effect} from 'effect';
      import {Plugin} from './src/tool/plugin/browser';
      import {Permission} from './src/permission';
      import {BrowserRuntime as R} from './src/browser/runtime';
      R.publishSessions([{id:'brw_foreign',name:'Foreign',project:'/foreign',projectID:'prj_foreign'}]);
      let tool;let permissionCalls=0;
      const ctx={session:{get:()=>Effect.succeed({id:'ses_owner',location:{directory:'/own'},metadata:{'orchestra:project-owner':{projectID:'prj_own'}}})},tool:{transform:fn=>Effect.sync(()=>fn({add:value=>tool=value}))}};
      await Effect.runPromise(Plugin.effect(ctx).pipe(Effect.provideService(Permission.Service,{assert:()=>{permissionCalls++;return Effect.void}})));
      const context={sessionID:'ses_owner',agent:'team-browser-agent'};
      let denied=0;
      for(const action of ['text','cookies','storage','eval','type','click','start','stop','assign','release']){
        const exit=await Effect.runPromise(Effect.exit(tool.execute({action,session:'brw_foreign'},context)));
        if(exit._tag!=='Failure')throw new Error('unexpected grant '+action);
        denied++;
      }
      const listing=await Effect.runPromise(tool.execute({action:'sessions'},context));
      if(JSON.stringify(listing).includes('Foreign')||JSON.stringify(listing).includes('brw_foreign'))throw new Error('foreign session leak');
      if(permissionCalls!==0)throw new Error('permission was reached before owner rejection');
      console.log('PLUGIN DENIED '+denied);
    `],{cwd:path.resolve(import.meta.dir,".."),encoding:"utf8",env:{...process.env,ORCHESTRA_DATA_DIR:root,ORCHESTRA_STATE_DIR:root,ORCHESTRA_CONFIG_DIR:root,ORCHESTRA_CACHE_DIR:root},timeout:15_000})
    expect(result.status,result.stderr).toBe(0)
    expect(result.stdout).toContain("PLUGIN DENIED 10")
  }finally{rmSync(root,{recursive:true,force:true})}
})

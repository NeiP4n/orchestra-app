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
      import {KV} from './src/kv';
      import {Plugin} from './src/tool/plugin/browser';
      import {Permission} from './src/permission';
      import {BrowserRuntime as R} from './src/browser/runtime';
      R.publishSessions([{id:'brw_foreign',name:'Foreign',project:'/foreign',projectID:'prj_foreign'}]);
      let tool;let permissionCalls=0;
      const ctx={session:{get:()=>Effect.succeed({id:'ses_owner',location:{directory:'/own'},metadata:{'orchestra:project-owner':{projectID:'prj_own'}}})},tool:{transform:fn=>Effect.sync(()=>fn({add:value=>tool=value}))}};
      await Effect.runPromise(Plugin.effect(ctx).pipe(Effect.provideService(KV.Service,{get:key=>Effect.succeed(key==='orchestra/owner/ses_owner'?'prj_own':key==='orchestra/project/prj_own'?{id:'prj_own',name:'Own',directory:'/own',created:1,main:'ses_owner'}:undefined),scan:()=>Effect.succeed({entries:[]})}),Effect.provideService(Permission.Service,{assert:()=>{permissionCalls++;return Effect.void}})));
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

test("actual plugin resolves canonical KV owner without metadata, lists own browser and reaches the normal start permission gate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestra-browser-main-owner-"))
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import {Effect} from 'effect';
      import {Plugin} from './src/tool/plugin/browser';
      import {Permission} from './src/permission';
      import {KV} from './src/kv';
      import {BrowserRuntime as R} from './src/browser/runtime';
      import {BrowserInstructions as I} from './src/browser/instructions';
      R.publishSessions([{id:'brw_own',name:'Browser1',project:'/test3',projectID:'prj_own'},{id:'brw_foreign',name:'Foreign',project:'/test3',projectID:'prj_foreign'}]);
      let tool,permissionCalls=0;
      const values=new Map([['orchestra/owner/ses_main','prj_own'],['orchestra/project/prj_own',{id:'prj_own',name:'Test3',directory:'/test3',created:1,main:'ses_main'}]]);
      const ctx={session:{get:()=>Effect.succeed({id:'ses_main',location:{directory:'/test3'}})},tool:{transform:fn=>Effect.sync(()=>fn({add:value=>tool=value}))}};
      await Effect.runPromise(Plugin.effect(ctx).pipe(Effect.provideService(KV.Service,{get:key=>Effect.succeed(values.get(key)),scan:()=>Effect.succeed({entries:[]})}),Effect.provideService(Permission.Service,{assert:()=>{permissionCalls++;return Effect.fail(new Error('TEST_PERMISSION_GATE'))}})));
      const context={sessionID:'ses_main',agent:'team-browser-agent'};
      const listing=JSON.stringify(await Effect.runPromise(tool.execute({action:'sessions'},context)));
      if(!listing.includes('Browser1')||listing.includes('Foreign')||listing.includes('brw_foreign'))throw Error('incorrect browser visibility: '+listing);
      if(!I.hasSessions('/test3','prj_own'))throw Error('browser not advertised');
      const start=await Effect.runPromise(Effect.exit(tool.execute({action:'start',session:'Browser1'},context)));
      if(start._tag!=='Failure'||!String(start.cause).includes('TEST_PERMISSION_GATE'))throw Error('start did not reach normal permission gate: '+String(start.cause));
      if(permissionCalls!==1)throw Error('permission gate not reached exactly once');
      console.log('CANONICAL OWNER OK');
    `,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          ORCHESTRA_DATA_DIR: root,
          ORCHESTRA_STATE_DIR: root,
          ORCHESTRA_CONFIG_DIR: root,
          ORCHESTRA_CACHE_DIR: root,
        },
        timeout: 15_000,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("CANONICAL OWNER OK")
    expect(existsSync(path.join(root, "browser-profiles", "brw_own"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

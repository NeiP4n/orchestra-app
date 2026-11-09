import {spawn}from'node:child_process';
const {BrowserRuntime:R}=await import('../../src/browser/runtime');const{BrowserWatch:W}=await import('../../src/browser/watch');const [mode,id]=process.argv.slice(2);let received=false;const off=W.onEvent(e=>{if(e.sessionID===id&&e.items.some(r=>r.text.startsWith('background incoming')))received=true});
try{
if(mode==='stop'){await R.closeBlockedBrowser(id);console.log('manual stop durable');}
else if(mode==='blocked'){await R.watchRestore(id);if(await R.profileRunning(id)||await R.watchEnsure(id))throw Error('manual stop undone');console.log('stays stopped, reason:',R.watcherReason(id));}
else if(mode==='batchowner'){
 await R.open(id);await R.tabs(id); // Same explicit launch used by ▶ All, without BrowserPane.
 const tabs=await R.tabs(id);await R.newTab(id,new URL('/blank',tabs[0]!.url).href);await R.selectTab(id,tabs[0]!.id);
 await new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,[import.meta.dir+'/browser-background-worker.ts','join',id],{cwd:import.meta.dir,env:process.env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>process.stdout.write(b));p.stderr.on('data',b=>process.stderr.write(b));p.on('exit',c=>c===0?resolve():reject(Error('observer child '+c))) });
 if(!await R.profileRunning(id))throw Error('observer killed owner Chrome');console.log('batch explicit start + independent observer, owner Chrome retained');
}else{
 if(mode==='activate'){if(await R.watchEnsure(id)||await R.profileRunning(id))throw Error('passive launch');if(!await R.watchActivate(id))throw Error('explicit activation failed');}
 else{await R.watchRestore(id);if(!await R.watchEnsure(id))throw Error('restore/join failed: '+R.watcherReason(id));}
 const until=Date.now()+16000;while(!received&&Date.now()<until){await new Promise(r=>setTimeout(r,300));await R.watchEnsure(id)}
 if(!received)throw Error('no background incoming');console.log('real incoming without pane');
}
}finally{off();await R.closeAllGraceful();R.closeAll()}

/** P1-1: real processes and explicit scheduler gates; no timing-luck assertions. */
import { test,expect } from "bun:test";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function child(env:Record<string,string|undefined>) {
 const proc=Bun.spawn([process.execPath,join(import.meta.dir,"../fixtures/instance-contender.ts")],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const rows:any[]=[];let text="";
 const done=(async()=>{for await(const c of proc.stdout){text+=new TextDecoder().decode(c);for(;;){const i=text.indexOf("\n");if(i<0)break;const line=text.slice(0,i);text=text.slice(i+1);console.log("lock-child",line);rows.push(JSON.parse(line));}}})();
 return {proc,rows,done};
}
async function until(fn:()=>any){const end=Date.now()+12000;while(!fn()){if(Date.now()>end)throw new Error("child scheduler timeout");await Bun.sleep(10);}return fn();}
for(const mode of ["OWNER","STALE","OPEN","PUBLISH"] as const)test(`P1-1 ${mode}: competing live holders cannot both acquire`,async()=>{
 const home=mkdtempSync(join(tmpdir(),"core-lock-r2-")),gate=join(home,"gate");
 const env={...process.env,HOME:home,NEO_HOME:join(home,".neo"),NEO_RUN_DIR:join(home,"run"),CONTENDER_GATE:gate};
 if(mode==="STALE"){mkdirSync(join(home,"run/core.lock"),{recursive:true});writeFileSync(join(home,"run/core.lock/owner.json"),JSON.stringify({pid:2147483647,startedAt:"2020",kind:"hub"}));}
 const a=child({...env,[`PAUSE_${mode}`]:"1"});let b:ReturnType<typeof child>|null=null;
 try{
  await until(()=>a.rows.find(r=>r.phase==="result"||r.phase==="after-mkdir"||r.phase==="before-stale-rename"||r.phase==="after-open"||r.phase==="before-publish"));
  b=child(env);const br=await until(()=>b!.rows.find(r=>r.phase==="result"));
  writeFileSync(gate,"continue");const ar=await until(()=>a.rows.find(r=>r.phase==="result"));
  expect([ar,br].filter(r=>r.ok),JSON.stringify({ar,br})).toHaveLength(1);
  const winner=ar.ok?a:b;expect(winner.proc.exitCode).toBeNull();
 }finally{
  writeFileSync(gate,"continue");for(const c of [a,b])if(c){try{c.proc.stdin.write("release\n");c.proc.stdin.end();}catch{}await Promise.race([c.proc.exited,Bun.sleep(1000)]);if(c.proc.exitCode===null)c.proc.kill(9);await c.proc.exited;await c.done;console.log("lock-child-stderr",await new Response(c.proc.stderr).text());}
  rmSync(home,{recursive:true,force:true});
 }
},30000);

test("P1-1 killed lease owner releases OS lock even while its spawned child is alive",async()=>{
 const home=mkdtempSync(join(tmpdir(),"core-lock-death-"));
 const env={...process.env,NEO_RUN_DIR:join(home,"run"),CONTENDER_GATE:join(home,"gate")};
 const a=child({...env,SPAWN_DESCENDANT:"1"});let b:ReturnType<typeof child>|null=null,descendant=0;
 try{
  expect((await until(()=>a.rows.find(r=>r.phase==="result"))).ok).toBe(true);
  descendant=(await until(()=>a.rows.find(r=>r.phase==="descendant"))).pid;
  a.proc.kill("SIGKILL");await a.proc.exited;
  process.kill(descendant,0); // The exec child must not inherit the SQLite lease.
  b=child(env);expect((await until(()=>b!.rows.find(r=>r.phase==="result"))).ok).toBe(true);
 }finally{
  if(descendant)try{process.kill(descendant,"SIGKILL");}catch{}
  for(const c of [a,b])if(c){if(c.proc.exitCode===null){c.proc.stdin.write("release\n");c.proc.stdin.end();}await c.proc.exited;await c.done;}
  rmSync(home,{recursive:true,force:true});
 }
},15000);

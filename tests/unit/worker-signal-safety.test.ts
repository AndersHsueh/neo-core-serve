/** P2 source risk test: record calls, never signal a real reused PID. */
import {test,expect} from "bun:test";
import {join} from "node:path";
test("P2 group ESRCH must never fall back to a positive PID",async()=>{
 const worker=join(import.meta.dir,"../../src/hub/worker.ts");
 const code=`const {killProcessGroup}=await import(${JSON.stringify(worker)});const calls=[];process.kill=((pid,signal)=>{calls.push([pid,signal]);throw Object.assign(new Error("gone"),{code:"ESRCH"});});killProcessGroup(2147483000,"SIGKILL");console.log(JSON.stringify(calls));`;
 const p=Bun.spawn([process.execPath,"-e",code],{stdout:"pipe",stderr:"pipe"});const text=(await new Response(p.stdout).text()).trim();expect(await p.exited).toBe(0);console.log("recorded signals",text);expect(JSON.parse(text)).toEqual([[-2147483000,"SIGKILL"]]);
});
for(const errno of ["EINVAL","ENOSYS"])test(`P2 ${errno}: no positive PID fallback on any group failure`,async()=>{
 const worker=join(import.meta.dir,"../../src/hub/worker.ts");
 const code=`const {killProcessGroup}=await import(${JSON.stringify(worker)});const calls=[];process.kill=((pid,signal)=>{calls.push([pid,signal]);throw Object.assign(new Error("group failure"),{code:${JSON.stringify(errno)}});});killProcessGroup(2147483000,"SIGTERM");console.log(JSON.stringify(calls));`;
 const p=Bun.spawn([process.execPath,"-e",code],{stdout:"pipe",stderr:"pipe"});const text=(await new Response(p.stdout).text()).trim();expect(await p.exited).toBe(0);console.log("recorded signals",text);expect(JSON.parse(text)).toEqual([[-2147483000,"SIGTERM"]]);
});
test("P2 exhausted group identity is latched; repeated cleanup cannot signal a reused PID/PGID",async()=>{
 const worker=join(import.meta.dir,"../../src/hub/worker.ts");
 const code=`const {WorkerClient}=await import(${JSON.stringify(worker)});const calls=[];process.kill=((pid,signal)=>{calls.push([pid,signal]);throw Object.assign(new Error("gone"),{code:"ESRCH"});});const proc={pid:2147483000,exited:new Promise(()=>{}),stdin:{end(){}},stdout:new ReadableStream({start(c){c.close();}}),stderr:new ReadableStream({start(c){c.close();}})};const c=new WorkerClient(proc,"fake");c.ready.catch(()=>{});c.signalGroup("SIGTERM");c.signalGroup("SIGKILL");c.stop();c.stop();await Bun.sleep(600);console.log(JSON.stringify(calls));process.exit(0);`;
 const p=Bun.spawn([process.execPath,"-e",code],{stdout:"pipe",stderr:"pipe"});const text=(await new Response(p.stdout).text()).trim();expect(await p.exited).toBe(0);console.log("idempotent signals",text);expect(JSON.parse(text)).toHaveLength(1);
});

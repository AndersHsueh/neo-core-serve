/** Deterministic scheduler, isolated in its own Bun process; never mocks parent modules. */
import * as fs from "node:fs";
import { mock } from "bun:test";
const gate = process.env["CONTENDER_GATE"]!;
const originalMkdir = fs.mkdirSync, originalRename = fs.renameSync, originalOpen = fs.openSync;
const pause = (phase: string) => {
  console.log(JSON.stringify({phase, pid:process.pid}));
  const until=Date.now()+10000;
  while(!fs.existsSync(gate)) { if(Date.now()>until)throw new Error("scheduler gate timeout"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
};
mock.module("node:fs",()=>({...fs,
 mkdirSync:(p:any,o:any)=>{const r=originalMkdir(p,o);if(process.env["PAUSE_OWNER"]==="1"&&String(p).endsWith("core.lock"))pause("after-mkdir");return r;},
 openSync:(p:any,f:any,m:any)=>{const r=originalOpen(p,f,m);if(process.env["PAUSE_OPEN"]==="1"&&String(p).endsWith("core.lock/owner.json")&&f==="wx")pause("after-open");return r;},
 renameSync:(a:any,b:any)=>{if(process.env["PAUSE_PUBLISH"]==="1"&&String(b).endsWith("core.lock/owner.json"))pause("before-publish");if(process.env["PAUSE_STALE"]==="1"&&(String(a).endsWith("core.lock")||String(a).endsWith("core.lock/owner.json")))pause("before-stale-rename");return originalRename(a,b);},
}));
const {acquireInstanceLock,readInstanceOwner,releaseInstanceLock}=await import("../../src/daemon/instance-lock.ts");
const got=acquireInstanceLock("hub");
console.log(JSON.stringify({phase:"result",pid:process.pid,ok:got.ok,owner:got.ok?readInstanceOwner(got.dir):got.owner}));
if(got.ok&&process.env["SPAWN_DESCENDANT"]==="1"){
 const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 console.log(JSON.stringify({phase:"descendant",pid:child.pid}));
}
await new Promise<void>(resolve=>{process.stdin.once("data",()=>resolve());});
if(got.ok){console.log(JSON.stringify({phase:"before-release",pid:process.pid,owner:readInstanceOwner(got.dir)}));releaseInstanceLock(got.dir);}

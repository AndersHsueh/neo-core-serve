/** P1-3 deterministic worker pre-ready barrier, not startup sleep. */
import {test,expect} from "bun:test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {TestEnv,WsClient,startHub,waitFor} from "../helpers.ts";
async function row(pid:number){const p=Bun.spawn(["ps","-o","pid=,ppid=,pgid=,stat=","-p",String(pid)],{stdout:"pipe",stderr:"ignore"});const text=(await new Response(p.stdout).text()).trim();await p.exited;console.log("inflight process",text||"gone");return text;}
test("P1-3 Hub stop drains a worker spawned but not ready/registered",async()=>{
 const env=await TestEnv.create("hub-inflight-stop"),wrapper=join(env.dirs.work,"worker-wrapper.ts"),pidFile=join(env.dirs.work,"spawn-ready"),gate=join(env.dirs.work,"startup-gate");
 writeFileSync(wrapper,`import {writeFileSync,existsSync} from "node:fs";
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
while(!existsSync(${JSON.stringify(gate)}))await Bun.sleep(10);
await import(${JSON.stringify(join(import.meta.dir,"../../src/main.ts"))});
`);
 const hub=await startHub({dirs:env.dirs,fake:env.fake,env:{MATRIX_CORE_ENTRY:wrapper}});let client:WsClient|null=null,pid=0;
 try{
  client=await WsClient.connect({url:hub.url,token:await hub.readToken()});await client.ready();
  const requested=client.request({type:"session.create",cwd:env.dirs.work,title:"delayed-worker"}).catch(()=>null);
  await waitFor(()=>existsSync(pidFile),{timeoutMs:10000,intervalMs:10,label:"worker is spawned before ready"});pid=Number(readFileSync(pidFile,"utf8"));
  expect(await row(pid)).toContain(String(hub.runInfo.pid));
  expect(await hub.stop()).toBe(0);
  const after=await row(pid);expect(after===""||/\bZ/.test(after),"unregistered worker escaped shutdown: "+after).toBe(true);
  await client.close();await requested;
 }finally{
  if(pid){try{process.kill(-pid,"SIGKILL");}catch{}}
  await client?.close();await hub.stop();await env.dispose();
 }
},30000);

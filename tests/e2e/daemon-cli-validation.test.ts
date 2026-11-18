/** P2: CLI parse/manager errors use fake systemctl/launchctl in an isolated HOME. */
import {test,expect} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";
import {defaultSpec,installService} from "../../src/daemon/service.ts";
const entry=join(import.meta.dir,"../../src/main.ts");
async function fixture(fn:(home:string,run:(args:string[])=>Promise<{code:number,out:string,err:string}>)=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),"core-cli-r2-")),bin=join(home,"bin");mkdirSync(bin);
 for(const name of ["systemctl","launchctl","journalctl"])writeFileSync(join(bin,name),'#!/bin/sh\nexit "${FAKE_MANAGER_EXIT:-0}"\n',{mode:0o755});
 const env={...process.env,HOME:home,NEO_HOME:join(home,".neo"),NEO_RUN_DIR:join(home,"run"),MATRIX_CORE_PLATFORM:"linux",MATRIX_CORE_SERVICE_BINDIR:bin,FAKE_MANAGER_EXIT:"5"};
 const run=async(args:string[])=>{const p=Bun.spawn([process.execPath,entry,"daemon",...args],{cwd:home,env,stdout:"pipe",stderr:"pipe"});return{code:await p.exited,out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text()};};
 try{await fn(home,run);}finally{rmSync(home,{recursive:true,force:true});}
}
for(const args of [["--port"],["--port","1.5"],["--port","65536"],["--port","-1"],["--cwd"],["--cwd","not-existing-dir"]])test(`P2 install rejects ${JSON.stringify(args)}`,()=>fixture(async(_h,run)=>{const r=await run(["install",...args]);expect(r.code).toBe(2);}),15000);
for(const port of ["0","65535"])test(`P2 valid integer port ${port} and relative cwd normalize`,()=>fixture(async(home,run)=>{
 const sub=join(home,"project");mkdirSync(sub);const r=await run(["install","--port",port,"--cwd","project"]);
 // Fake manager rejects, but safe config generation must use absolute normalized cwd.
 expect(r.code).not.toBe(0);const text=readFileSync(join(home,".config/systemd/user/neo-core-serve.service"),"utf8");expect(text).toContain(sub);
}),15000);
for(const sub of ["start","stop","restart","status","logs","uninstall"])test(`P2 ${sub} CLI propagates manager failure`,()=>fixture(async(home,run)=>{
 const spec=defaultSpec({home,cwd:home,platform:"linux"});const file=(await installService(spec,{run:async()=>({code:0,stdout:"",stderr:""})})).file;
 const r=await run([sub]);expect(r.code).not.toBe(0);if(sub==="uninstall"){expect(r.out).not.toContain("已卸载");expect(existsSync(file)).toBe(true);}
}),15000);

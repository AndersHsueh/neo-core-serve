/** R2 service safety: temporary homes + injected runner only, never installs host services. */
import {test,expect} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,existsSync,rmSync,lstatSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {defaultSpec,renderSystemdUnit,renderManagedContent,installService,uninstallService,startService,stopService,restartService,serviceManagerStatus,readDaemonLogs,systemdUnitPath,launchAgentPath,type ServiceRunner} from "../../src/daemon/service.ts";
const ok:ServiceRunner={run:async()=>({code:0,stdout:"fake manager",stderr:""})};
function temp(){const home=mkdtempSync(join(tmpdir(),"core-service-r2-"));return{home,spec:defaultSpec({home,cwd:home,platform:"linux"}),close:()=>rmSync(home,{recursive:true,force:true})};}
for(const field of ["cwd","pathEnv","home","entryPath","bunPath"] as const)test(`P1-4 ${field}: reject line/control injection`,()=>{
 const spec=defaultSpec({platform:"linux",[field]:"/tmp/neo\nExecStartPost=/usr/bin/true"});
 expect(()=>renderSystemdUnit(spec)).toThrow();
});
test("P1-4 specifiers and shell variables are literal, whitespace/quotes/backslashes encoded",()=>{
 const unit=renderSystemdUnit(defaultSpec({platform:"linux",cwd:'/tmp/sp ace/"q"/back\\slash/%h/$HOME',home:'/tmp/h ome/%h/$HOME',pathEnv:'/opt/my bin:"q":back\\slash:%h:$HOME',entryPath:'/opt/a b/"q"/back\\slash/%h/$HOME.ts',bunPath:'/opt/a b/bun'}));
 const exec=unit.split("\n").find(l=>l.startsWith("ExecStart="))!;
 expect(exec).toContain("%%h");expect(exec).toContain("$$HOME");expect(exec).toContain('\\"q\\"');expect(exec).toContain("back\\\\slash");
 for(const key of ["WorkingDirectory=","Environment=PATH=","Environment=HOME="]){
  const line=unit.split("\n").find(l=>l.startsWith(key)||l.startsWith(key.replace("=",'=\"')));
  expect(line,`${key} must be a single safely quoted field`).toBeDefined();
 }
 expect(unit).not.toContain("ExecStartPost=");
});
for(const platform of ["linux","darwin"] as const)for(const kind of ["symlink","foreign","directory"] as const)test(`P1-5 ${platform} install refuses ${kind}`,async()=>{
 const t=temp();try{
  const spec={...t.spec,platform},file=platform==="linux"?systemdUnitPath(t.home):launchAgentPath(t.home),notes=join(t.home,"notes.txt");
  mkdirSync(dirname(file),{recursive:true});writeFileSync(notes,"KEEP-MY-NOTES");
  if(kind==="symlink")symlinkSync(notes,file);else if(kind==="foreign")writeFileSync(file,"FOREIGN-CONTENT");else mkdirSync(file);
  let calls=0;let refused=false;try{const r=await installService(spec,{run:async()=>{calls++;return {code:0,stdout:"",stderr:""};}});refused=r.code!==0;}catch{refused=true;}
  expect(refused).toBe(true);expect(calls).toBe(0);expect(readFileSync(notes,"utf8")).toBe("KEEP-MY-NOTES");
  if(kind==="foreign")expect(readFileSync(file,"utf8")).toBe("FOREIGN-CONTENT");
  if(kind==="symlink")expect(lstatSync(file).isSymbolicLink()).toBe(true);
 }finally{t.close();}
});
for(const platform of ["linux","darwin"] as const)test(`P1-5 ${platform} managed reinstall and uninstall`,async()=>{
 const t=temp();try{const spec={...t.spec,platform};const a=await installService(spec,ok);expect(a.code).toBe(0);
  const b=await installService({...spec,port:4321},ok);expect(b.code).toBe(0);expect(readFileSync(b.file,"utf8")).toContain("4321");
  expect(lstatSync(b.file).isSymbolicLink()).toBe(false);expect((await uninstallService(spec,ok)).code).toBe(0);expect(existsSync(b.file)).toBe(false);
 }finally{t.close();}
});
for(const platform of ["linux","darwin"] as const)test(`P1-5 ${platform} uninstall refuses foreign files`,async()=>{
 const t=temp();try{const spec={...t.spec,platform},file=platform==="linux"?systemdUnitPath(t.home):launchAgentPath(t.home);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"FOREIGN-CONTENT");
  let refused=false;try{refused=(await uninstallService(spec,ok)).code!==0;}catch{refused=true;}
  expect(refused).toBe(true);expect(readFileSync(file,"utf8")).toBe("FOREIGN-CONTENT");
 }finally{t.close();}
});
for(const platform of ["linux","darwin"] as const)test(`P2 ${platform}: failed stop/uninstall keeps managed file`,async()=>{
 const t=temp();try{const spec={...t.spec,platform},installed=await installService(spec,ok),bytes=readFileSync(installed.file,"utf8"),fail:ServiceRunner={run:async()=>({code:5,stdout:"",stderr:"manager failed"})};
  expect((await stopService(spec,fail)).code).toBe(5);expect((await uninstallService(spec,fail)).code).toBe(5);expect(readFileSync(installed.file,"utf8")).toBe(bytes);
 }finally{t.close();}
});
test("P2 Darwin bootstrap succeeds but kickstart failure remains failure",async()=>{
 const t=temp();try{const spec={...t.spec,platform:"darwin" as const};await installService(spec,ok);let n=0;
  const r=await startService(spec,{run:async()=>({code:++n===1?0:5,stdout:"",stderr:"fake kickstart failure"})});expect(r.code).toBe(5);
 }finally{t.close();}
});
for(const platform of ["linux","darwin"] as const)test(`P2 ${platform} manager failure matrix`,async()=>{
 const t=temp();try{const spec={...t.spec,platform};await installService(spec,ok);const fail:ServiceRunner={run:async()=>({code:7,stdout:"",stderr:"fake failure"})};
  expect((await startService(spec,fail)).code).toBe(7);expect((await stopService(spec,fail)).code).toBe(7);expect((await restartService(spec,fail)).code).toBe(7);expect((await serviceManagerStatus(spec,fail)).manager?.code).toBe(7);
  if(platform==="linux")expect((await readDaemonLogs(spec,fail)).code).toBe(7);
 }finally{t.close();}
});
test("P1-4 field-specific encoding preserves scalar cwd and literal environment dollar",()=>{
 const cwd='/tmp/a b/"q"/back\\slash/%h/$HOME';
 const unit=renderSystemdUnit(defaultSpec({platform:"linux",cwd,home:'/tmp/a b/$HOME',pathEnv:'/bin:$HOME'}));
 expect(unit.split('\n').find(l=>l.startsWith('WorkingDirectory='))).toBe('WorkingDirectory='+cwd.replaceAll('%','%%'));
 expect(unit.split('\n').find(l=>l.startsWith('Environment=')&&l.includes('HOME='))).toBe('Environment="HOME=/tmp/a b/$HOME"');
 expect(unit).toContain('Environment=PATH=/bin:$HOME');
});

test("P1-4 managed plist keeps XML declaration first and argv literals separated",()=>{
 const text=renderManagedContent(defaultSpec({platform:"darwin",cwd:`/tmp/a b/'q'/"q"/back\\slash/%h/$HOME`}));
 expect(text.startsWith('<?xml version="1.0"')).toBe(true);
 expect(text).toContain('&quot;q&quot;');expect(text).toContain('%h/$HOME');
});
for(const platform of ["linux","darwin"] as const)test(`P2 ${platform} install manager failure is not success`,async()=>{
 const t=temp();try{
  const r=await installService({...t.spec,platform},{run:async()=>({code:9,stdout:"",stderr:"fake install failure"})});
  expect(r.code).toBe(9);expect(existsSync(r.file)).toBe(true);
 }finally{t.close();}
});

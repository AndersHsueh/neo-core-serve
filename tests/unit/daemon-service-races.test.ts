import {test,expect} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
for(const point of ["claim","publish"])for(const mode of (point==="claim"?["new","reinstall","uninstall"]:["new","reinstall"]))for(const kind of ["foreign","symlink"])test(`P1-5 race ${point}/${mode}/${kind}: never replace or remove a foreign destination`,async()=>{
 const home=mkdtempSync(join(tmpdir(),"core-target-race-"));
 try{
  const p=Bun.spawn([process.execPath,join(import.meta.dir,"../fixtures/service-target-race.ts")],{env:{...process.env,RACE_HOME:home,RACE_MODE:mode,RACE_KIND:kind,RACE_POINT:point},stdout:"pipe",stderr:"pipe"});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  console.log({point,mode,kind,out,err,code});expect(code).toBe(0);const r=JSON.parse(out.trim());
  expect(r.raced).toBe(true);expect(r.code).not.toBe(0);expect(r.notes).toBe("EXTERNAL-NOTES");expect(r.exists).toBe(true);
  expect(r.symlink).toBe(kind==="symlink");expect(r.content).toBe(kind==="symlink"?"EXTERNAL-NOTES":"FOREIGN-REPLACEMENT");
 }finally{rmSync(home,{recursive:true,force:true});}
});

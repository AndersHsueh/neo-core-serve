/** Isolated filesystem scheduler: swap the destination after validation, before mutation. */
import * as fs from "node:fs";
import {mock} from "bun:test";
import {join,dirname} from "node:path";
const home=process.env["RACE_HOME"]!,mode=process.env["RACE_MODE"]!,kind=process.env["RACE_KIND"]!;
const file=join(home,".config/systemd/user/neo-core-serve.service"),notes=join(home,"notes");
fs.writeFileSync(notes,"EXTERNAL-NOTES");
let armed=false,raced=false;
function swap(a:unknown,b?:unknown){
 if(process.env["RACE_POINT"]==="publish"&&String(b)!==file)return;
 if(!armed||raced||(String(a)!==file&&String(b)!==file))return;
 raced=true;fs.rmSync(file,{force:true});
 if(kind==="symlink")fs.symlinkSync(notes,file);else fs.writeFileSync(file,"FOREIGN-REPLACEMENT");
}
const rename=fs.renameSync,link=fs.linkSync,rm=fs.rmSync;
mock.module("node:fs",()=>({...fs,
 renameSync:(a:any,b:any)=>{swap(a,b);return rename(a,b);},
 linkSync:(a:any,b:any)=>{swap(a,b);return link(a,b);},
 rmSync:(a:any,o:any)=>{swap(a);return rm(a,o);},
}));
const {defaultSpec,installService,uninstallService}=await import("../../src/daemon/service.ts");
const spec=defaultSpec({home,cwd:home,platform:"linux"});
const runner={run:async()=>({code:0,stdout:"",stderr:""})};
if(mode!=="new")await installService(spec,runner);else fs.mkdirSync(dirname(file),{recursive:true});
armed=true;let code=0,error="";
try {code=(await(mode==="uninstall"?uninstallService(spec,runner):installService({...spec,port:4321},runner))).code;}catch(e){code=2;error=String(e);}
console.log(JSON.stringify({raced,code,error,notes:fs.readFileSync(notes,"utf8"),exists:fs.existsSync(file),symlink:fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink(),content:fs.existsSync(file)?fs.readFileSync(file,"utf8"):null}));

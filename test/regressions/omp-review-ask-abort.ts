import { registerAskTool } from '../../src/core/ask-tool.ts';
import { Bridge } from '../../src/core/bridge.ts';
let tool:any; const schema=():any=>{const s:any={describe:()=>s,optional:()=>s,min:()=>s};return s};
const zod:any=Object.fromEntries(['object','array','string','number','boolean'].map(n=>[n,()=>schema()]));
const cfg:any={enabled:true,quiet:false,question:{enabled:true,timeoutMs:600000},control:{enabled:true},stream:{enabled:false,clientId:''},notify:{maxTextChars:1800}};
const sender:any={configured:true,stats:{},enqueue(){},updateConfig(){}};
const adapter:any={loadConfig:()=>({config:cfg,sources:[],warnings:[]}),resolveRobot:(c:any)=>c,createSender:()=>sender,createRouter:()=>({handle(){}}),formatter:{questionRequest:()=>({title:'Q',text:'Q'}),questionAnsweredLocally:()=>({title:'Q',text:'Q'})}};
const bridge=new Bridge({sendUserMessage(){}},'/tmp',adapter); bridge.takenOver=true;
// This fixture isolates cancellation with a valid channel owner.
bridge.lock={isOwner:()=>true,heldByOther:()=>false} as any;
registerAskTool({zod,registerTool:(t:any)=>tool=t} as any,()=>bridge);
const outer=new AbortController(); let localSignal:AbortSignal|undefined;let settled=false;
const ctx:any={cwd:'/tmp',invokeTool:(_p:any,opts:any)=>new Promise((_res,rej)=>{localSignal=opts.signal;opts.signal.addEventListener('abort',()=>rej(new Error('aborted')));})};
void tool.execute('x',{questions:[{id:'q',question:'Which?',options:[{label:'A'},{label:'B'}]}]},outer.signal,undefined,ctx).catch(()=>{}).finally(()=>settled=true);
await new Promise(r=>setTimeout(r,10));outer.abort();await new Promise(r=>setTimeout(r,20));
console.log(JSON.stringify({outerAborted:outer.signal.aborted,localAborted:localSignal?.aborted,pendingRemote:bridge.questions.size,toolSettled:settled}));
process.exit(0);

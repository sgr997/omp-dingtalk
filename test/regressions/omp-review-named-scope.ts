import {writeFileSync,mkdtempSync} from 'node:fs';
import {loadConfig,resolveRobotConfig} from '../../src/platforms/dingtalk/config.ts';
import {CommandRouter} from '../../src/platforms/dingtalk/router.ts';
const scratch=mkdtempSync('/tmp/omp-review-scope-');process.env.OMP_DINGTALK_CONFIG=scratch+'/config.json';writeFileSync(process.env.OMP_DINGTALK_CONFIG,JSON.stringify({control:{scope:'direct',allowUserId:'staff'},robots:{typo:{control:{scope:'diretc'}}}}));
const cfg=resolveRobotConfig(loadConfig(scratch).config,'typo');let promptCount=0;const router=new CommandRouter({cfg,log:{debug(){},info(){},warn(){},error(){}},sender:{sendEmotion:async()=>({ok:true}),send:async()=>({ok:true})},approvals:{size:0},questions:{size:0},pi:{sendUserMessage(){promptCount++}},getCtx:()=>({isIdle:()=>true}),statusLines:()=>[],isQuiet:()=>false,setQuiet(){}} as any);
await router.handle({conversationType:'2',isInAtList:true,senderStaffId:'staff',text:{content:'run group command'}});
console.log(JSON.stringify({namedScope:cfg.control.scope,groupPromptDelivered:promptCount}));

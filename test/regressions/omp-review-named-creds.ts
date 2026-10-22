import {writeFileSync,mkdtempSync} from 'node:fs';
import {Bridge} from '../../src/core/bridge.ts';
import {dingtalkAdapter} from '../../src/platforms/dingtalk/adapter.ts';
const scratch=mkdtempSync('/tmp/omp-review-creds-');process.env.OMP_DINGTALK_CONFIG=scratch+'/config.json';process.env.OMP_DINGTALK_LOCK_DIR=scratch+'/locks';
writeFileSync(process.env.OMP_DINGTALK_CONFIG,JSON.stringify({stream:{enabled:false},robots:{broken:{stream:{enabled:true,clientId:'mock-client',clientSecret:''}}}}));
globalThis.fetch=(async()=>{throw new Error('Unexpected external request')}) as any;
const b=new Bridge({sendUserMessage(){},logger:{debug(){},info(){},warn(){},error(){}}} as any,scratch,dingtalkAdapter);const result=b.takeOver('broken');
console.log(JSON.stringify({result,takenOver:b.takenOver,streamStatus:b.streamStatus,held:b.lock?.held}));b.release();

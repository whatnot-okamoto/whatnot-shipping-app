import assert from 'node:assert/strict';
import { requestM1Refetch } from '../app/orders/components/init-and-refetch-flow.ts';
const context={success:true,workflow_epoch:'epoch',source_cycle_id:'old',source_publication_revision:1,
 previous_attempt_id:'previous',attempt_status:'published',diff_confirmed_flag:true};
let posts=0, inspections=0;
const result=await requestM1Refetch(async(url,options)=>{
 if(String(url).includes('?request_id=')){inspections++;return Response.json({success:true,diff_result:{refetch_cycle_id:'new'}});}
 if(options?.method==='POST'){posts++;const body=JSON.parse(options.body);assert.equal(body.workflow_epoch,'epoch');throw new Error('response lost');}
 return Response.json(context);
});
assert.equal((await result.json()).diff_result.refetch_cycle_id,'new');assert.equal(posts,1);assert.equal(inspections,1);
const unknown=await requestM1Refetch(async(url,options)=>{
 if(String(url).includes('?request_id='))return Response.json({success:true,attempt_status:'running'});
 if(options?.method==='POST')throw new Error('response lost');
 return Response.json(context);
});
assert.equal(unknown.status,409);
let writes=0;
const missing=await requestM1Refetch(async(_url,options)=>{if(options?.method==='POST')writes++;return Response.json({success:true});});
assert.equal(missing.status,409);assert.equal(writes,0);
console.log('M1 refetch UI: explicit compare tokens, response-loss inspection, no blind retry passed');

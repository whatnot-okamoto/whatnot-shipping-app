import assert from 'node:assert/strict';
import { runInitAndRefetch } from '../app/orders/components/init-and-refetch-flow.ts';
import { getInitializationActionView } from '../app/orders/components/diff-confirm-view-policy.ts';
const diff={refetch_cycle_id:'next',has_diff:false,has_new_uninitialized:false,new_uninitialized_count:0,
 recovery_status:'fresh',can_initialize:false,can_confirm:true,first_absence_count:0,cycle_not_in_open_orders_count:0,diff_summary:[]};
for(const uninitialized of [false,true]){
 const calls=[];
 const result=await runInitAndRefetch('source',async(url,options)=>{
  calls.push([String(url),options]);
  if(String(url)==='/api/orders/init')return Response.json({success:true,status:'completed'});
  if(options?.method!=='POST')return Response.json({success:true,workflow_epoch:'epoch',source_cycle_id:'source',
   source_publication_revision:1,previous_attempt_id:'prior',attempt_status:'published',post_init_refetch_ready:true});
  assert.equal(JSON.parse(options.body).source_cycle_id,'source');
  return Response.json({success:true,diff_result:{...diff,has_new_uninitialized:uninitialized}});
 });
 assert.equal(calls.length,3);assert.equal(result.success,!uninitialized);
 if(uninitialized){assert.equal(result.requiresReload,true);assert.match(result.error,/未初期化/);}
 assert.ok(calls[0][1].signal instanceof AbortSignal);
}
const failed=await runInitAndRefetch('source',async()=>Response.json({success:false,message:'初期化失敗'},{status:409}));
assert.equal(failed.success,false);
assert.equal(getInitializationActionView({has_new_uninitialized:true,can_initialize:false,recovery_status:'conflict',new_uninitialized_count:1}).visible,false);
console.log('M1 init UI: guarded auto-refetch, incomplete result, conflict action suppression passed');

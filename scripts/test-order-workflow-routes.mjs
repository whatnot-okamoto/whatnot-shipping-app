import assert from 'node:assert/strict';
import { reset, order, redis, refetch, diff, session, list, fake, post, request, fetchCurrent, confirm, read, stateStore } from './fakes/m1-workflow-fixture.mjs';
await reset([order('A'), order('B')]);
for (let i=0;i<1215;i++) await redis.sadd('index:orders', 'PAST'+i);
await redis.set('order_snapshot_pending:A', 'legacy-A');
const initial = await read('orders:refetch_state');
assert.equal((await post(session, { selected_unique_keys:['A'], refetch_cycle_id:'old' })).status,409);
const fresh = await fetchCurrent();
assert.equal(Object.keys(fresh.state.order_results).length,2);
assert.equal(Object.keys(fresh.state.confirmation_manifest).length,2);
assert.equal(await redis.get('order_snapshot_pending:A'),'legacy-A');
assert.ok(await redis.get(stateStore.pendingKey(initial.workflow_epoch,'A')));
assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:fresh.state.refetch_cycle_id})).status,409);
const cycle=await confirm();
assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:'wrong'})).status,409);
assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:cycle})).status,200);
await reset([order('OK'),order('FAIL')]);
fake.setWorkflowFetchFailures(['FAIL']); await fetchCurrent(); const partialCycle=await confirm();
const shown=await list.GET(new Request('http://local/api/orders/list')); assert.equal(shown.status,200);
const rows=(await shown.json()).orders; assert.equal(rows.length,2);
assert.equal(rows.find(r=>r.unique_key==='FAIL').selectable_for_session,false);
assert.equal((await post(session,{selected_unique_keys:['OK'],refetch_cycle_id:partialCycle})).status,200);
await reset();
const input=await request(); assert.equal((await post(refetch,input)).status,200);
assert.equal((await post(refetch,{...input,workflow_epoch:'different'})).status,409);
const current=await read('orders:refetch_state'); current.workflow_epoch='old';
await redis.set('orders:refetch_state',JSON.stringify(current));
assert.equal((await post(diff,{refetch_cycle_id:current.refetch_cycle_id})).status,409);
// Moving A from {A,B} to C's bundle holds both groups, including on the next cycle.
for(const later of [false,true]) {
 const a=order('A','old'), b=order('B','old'), c=order('C','new'), d=order('D','independent');
 await reset([a,b,c,d]);
 const oldGroup=(await read('order_snapshot:A')).bundle_group_id;
 const newGroup=(await read('order_snapshot:C')).bundle_group_id;
 const oldBundleRaw=await redis.getRawString('bundle:'+oldGroup);
 const moved=order('A','new');fake.setWorkflowBaseOrders([moved,b,c,d]);
 let fetched=await fetchCurrent();
 assert.deepEqual(new Set(fetched.state.held_bundle_order_keys),new Set(['A','B','C']));await confirm();
 if(later) {
  // Synthetic existing new composition; the old U2 still retains A. No application repair is invoked.
  const newBundle=await read('bundle:'+newGroup);newBundle.order_unique_keys.push('A');
  await redis.set('bundle:'+newGroup,JSON.stringify(newBundle));
  fetched=await fetchCurrent();await confirm();
  assert.deepEqual(new Set(fetched.state.held_bundle_order_keys),new Set(['A','B','C']));
 }
 const response=await list.GET(new Request('http://local/api/orders/list'));assert.equal(response.status,200);
 const rows=(await response.json()).orders;
 for(const id of ['A','B','C'])assert.equal(rows.find(o=>o.unique_key===id).selectable_for_session,false);
 assert.equal(rows.find(o=>o.unique_key==='D').selectable_for_session,true);
 assert.equal((await post(session,{selected_unique_keys:['B'],refetch_cycle_id:fetched.state.refetch_cycle_id})).status,409);
 assert.equal((await post(session,{selected_unique_keys:['D'],refetch_cycle_id:fetched.state.refetch_cycle_id})).status,200);
 assert.equal(await redis.getRawString('bundle:'+oldGroup),oldBundleRaw);
}
for(const damage of ['missing-bundle','invalid-bundle','missing-snapshot','invalid-snapshot']) {
 await reset([order('A'),order('OK','independent')]);
 const group=(await read('order_snapshot:A')).bundle_group_id;
 if(damage==='missing-bundle')await redis.del('bundle:'+group);
 if(damage==='invalid-bundle')await redis.set('bundle:'+group,JSON.stringify({bundle_group_id:group,order_unique_keys:'invalid'}));
 if(damage==='missing-snapshot')await redis.del('order_snapshot:A');
 if(damage==='invalid-snapshot')await redis.set('order_snapshot:A',JSON.stringify({unique_key:'A',bundle_group_id:'invalid'}));
 const preserved=await redis.getRawString('order_snapshot:A');
 const f=await fetchCurrent();assert.ok(f.state.held_bundle_order_keys.includes('A'));
 assert.ok(!f.state.initialization_keys.includes('A'));await confirm();
 assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:f.state.refetch_cycle_id})).status,409);
 assert.equal((await post(session,{selected_unique_keys:['OK'],refetch_cycle_id:f.state.refetch_cycle_id})).status,200);
 if(damage==='missing-snapshot')assert.equal(await redis.get('order_snapshot:A'),null);
 if(damage==='invalid-snapshot')assert.equal(await redis.getRawString('order_snapshot:A'),preserved);
}
console.log('M1 order routes: positive sets, U2 move initial/later cycles, healthy U2 continuation, unknown membership fail-closed passed');

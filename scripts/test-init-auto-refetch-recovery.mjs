import assert from 'node:assert/strict';
import { reset, order, redis, init, fake, post, fetchCurrent, confirm, read } from './fakes/m1-workflow-fixture.mjs';
const orders=[order('A'),order('B')]; await reset(orders,[]);
const {state}=await fetchCurrent();
fake.setWorkflowFetchFailures(['A']);
let response=await post(init,{refetch_cycle_id:state.refetch_cycle_id}); let result=await response.json();
assert.equal(response.status,200); assert.equal(result.success,false);
assert.ok(await redis.get('order:B')); assert.equal(await redis.get('order:A'),null);
const b=await read('order:B'); b.app_memo='preserve'; await redis.set('order:B',JSON.stringify(b));
assert.equal((await read('orders:refetch_state')).post_init_refetch_ready,false);
fake.setWorkflowFetchFailures([]);
response=await post(init,{refetch_cycle_id:state.refetch_cycle_id}); result=await response.json();
assert.equal(result.success,true); assert.equal((await read('order:B')).app_memo,'preserve');
assert.equal((await read('order_snapshot:A')).workflow_epoch,undefined);
await fetchCurrent(); await confirm();
await reset([order('NEW')],[]); const next=await fetchCurrent();
fake.setWorkflowBaseOrders([]);
response=await post(init,{refetch_cycle_id:next.state.refetch_cycle_id}); assert.equal((await response.json()).success,true);
const empty=await fetchCurrent(); assert.deepEqual(empty.state.current_order_keys,[]); await confirm();
await reset([order('A')],[]); const broken=await fetchCurrent();
fake.setWorkflowOrderListRawResult(null);
assert.equal((await post(init,{refetch_cycle_id:broken.state.refetch_cycle_id})).status,409);
assert.equal((await read('orders:refetch_state')).post_init_refetch_ready,undefined);
// Inconsistent phase/flags/epoch must be rejected before BASE or lease writes.
for (const patch of [{has_new_uninitialized:false},{new_uninitialized_count:0},{phase:'promoting'},{workflow_epoch:'old'}]) {
 await reset([order('A')],[]); const f=await fetchCurrent();
 await redis.set('orders:refetch_state',JSON.stringify({...f.state,...patch}));
 const raw=await redis.getRawString('orders:refetch_state'); const before=fake.getWorkflowOrderListCallCount();
 assert.equal((await post(init,{refetch_cycle_id:f.state.refetch_cycle_id})).status,409);
 assert.equal(fake.getWorkflowOrderListCallCount(),before);
 assert.equal(await redis.getRawString('orders:refetch_state'),raw);
 assert.equal(await redis.get('orders:workflow_operation_lease'),null);
}
// A pre-existing index with incomplete storage remains repairable without overwriting U1 operations.
await reset([order('REPAIR')]); await redis.del('order_snapshot:REPAIR');
const repairU1=await read('order:REPAIR'); repairU1.app_memo='keep-after-repair';
await redis.set('order:REPAIR',JSON.stringify(repairU1));
const repairing=await fetchCurrent(); assert.deepEqual(repairing.state.initialization_keys,['REPAIR']);
assert.equal((await post(init,{refetch_cycle_id:repairing.state.refetch_cycle_id})).status,200);
assert.equal((await read('order:REPAIR')).app_memo,'keep-after-repair');
await fetchCurrent(); await confirm();
console.log('M1 init: partial retry, preserved operations, empty observation, malformed list, unsafe flags and incomplete-index repair passed');

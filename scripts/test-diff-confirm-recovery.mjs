import assert from 'node:assert/strict';
import { reset, redis, diff, session, post, fetchCurrent, confirm, read, stateStore } from './fakes/m1-workflow-fixture.mjs';
// Old recovery pairs are preserved but never consumed, including an inconsistent legacy index.
await reset(); await redis.sadd('index:order_snapshot_pending','orphan');
await redis.set('order_snapshot_pending:A','legacy');
const {state}=await fetchCurrent();
const oldSnapshot=await read('order_snapshot:A'); assert.equal(oldSnapshot.workflow_epoch,undefined);
await confirm(); const promoted=await read('order_snapshot:A');
assert.equal(promoted.workflow_epoch,state.workflow_epoch);
assert.equal(promoted.pdf_verification_cycle_id,state.refetch_cycle_id);
assert.equal(await redis.get('order_snapshot_pending:A'),'legacy');
assert.deepEqual(await redis.smembers('index:order_snapshot_pending'),['orphan']);
assert.equal((await post(diff,{refetch_cycle_id:state.refetch_cycle_id})).status,200);
for (const corrupt of ['missing','wrong-epoch','wrong-content','wrong-index']) {
 await reset(); const {state:s}=await fetchCurrent();
 if(corrupt==='missing') await redis.del(stateStore.pendingKey(s.workflow_epoch,'A'));
 if(corrupt==='wrong-epoch'||corrupt==='wrong-content'){
   const p=await read(stateStore.pendingKey(s.workflow_epoch,'A'));
   if(corrupt==='wrong-epoch')p.workflow_epoch='old'; else p.remark+='changed';
   await redis.set(stateStore.pendingKey(s.workflow_epoch,'A'),JSON.stringify(p));
 }
 if(corrupt==='wrong-index') await redis.set(stateStore.pendingIndexKey(s.workflow_epoch),JSON.stringify({schema_version:1,workflow_epoch:s.workflow_epoch,refetch_cycle_id:s.refetch_cycle_id,keys:[]}));
 assert.equal((await post(diff,{refetch_cycle_id:s.refetch_cycle_id})).status,409);
 assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:s.refetch_cycle_id})).status,409);
}
await reset(); const fresh=await fetchCurrent(); const m=redis.fencedMutate.bind(redis);
redis.fencedMutate=async()=>{throw new Error('after promotion');};
assert.equal((await post(diff,{refetch_cycle_id:fresh.state.refetch_cycle_id})).status,409);
redis.fencedMutate=m; await confirm();
assert.equal((await read('orders:refetch_state')).phase,'confirmed');
console.log('M1 diff recovery: no-change stamp, missing pairs, epoch/content/index corruption and resume passed');

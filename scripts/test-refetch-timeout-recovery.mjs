import assert from 'node:assert/strict';
import { reset, order, redis, refetch, fake, session, post, request, fetchCurrent, confirm, read } from './fakes/m1-workflow-fixture.mjs';
for(const mode of ['http','schema','limit','payload']){
 await reset(); await fetchCurrent(); const cycle=await confirm();
 const before=await redis.getRawString('orders:refetch_state');
 if(mode==='http')fake.setWorkflowOrderListFailure(new Error('fixture failure'));
 if(mode==='schema')fake.setWorkflowOrderListRawResult({orders:[]});
 if(mode==='limit')fake.setWorkflowBaseOrders(Array.from({length:101},(_,i)=>order('A'+i)));
 if(mode==='payload'){const o=order('A');o.remark='界'.repeat(30000);fake.setWorkflowBaseOrders([o]);}
 const response=await post(refetch,await request()); assert.equal(response.status,409,mode);
 assert.equal(await redis.getRawString('orders:refetch_state'),before,mode);
 assert.equal((await read('orders:refetch_attempt')).status,'failed');
 assert.equal((await post(session,{selected_unique_keys:['A'],refetch_cycle_id:cycle})).status,409);
}
await reset(); await fetchCurrent(); await confirm();
const gate=fake.installWorkflowOrderListGate(); const input=await request();
const controller=new AbortController();
const pending=refetch.POST(new Request('http://local/api/orders/refetch',{method:'POST',body:JSON.stringify(input),signal:controller.signal}));
await gate.entered; controller.abort();
assert.equal((await pending).status,409); gate.release();
assert.equal((await read('orders:refetch_attempt')).status,'failed');
console.log('M1 refetch failures: HTTP/schema/limits/abort preserve data and revoke old eligibility');

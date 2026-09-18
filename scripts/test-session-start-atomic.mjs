import assert from 'node:assert/strict';
import { reset, order, redis, session, post, fetchCurrent, confirm, read, store } from './fakes/m1-workflow-fixture.mjs';
import { MemoryRedis } from '../lib/memory-redis.ts';
import { encodeSessionStart, RAW_BATCH_SCRIPT, SESSION_START_SCRIPT } from '../lib/redis-like.ts';
import { UpstashRedisAdapter } from '../lib/upstash.ts';
import { createDevelopmentRedis, DEVELOPMENT_REDIS_NAMESPACE } from '../lib/namespaced-redis.ts';
const hold=await import('../app/api/orders/hold/route.ts');
const carrier=await import('../app/api/orders/carrier/route.ts');
const current=await import('../app/api/session/current/route.ts');
const patch=(route,body)=>route.PATCH(new Request('http://local/api/test',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
const start=(cycle,ids=['A'])=>post(session,{selected_unique_keys:ids,refetch_cycle_id:cycle});
const ready=async()=>{await reset();await fetchCurrent();return confirm();};
const atomic=redis.fencedStartSession.bind(redis);
let count=0;

// A: the update has committed after validation but before the final atomic comparison.
for(const kind of ['hold','carrier','bundle','snapshot','snapshot-delete','snapshot-wrongtype']) {
 const cycle=await ready(), stateRaw=await redis.getRawString('orders:refetch_state');
 let candidate;
 redis.fencedStartSession=async(...args)=>{
  candidate=args[4];
  if(kind==='hold') assert.equal((await patch(hold,{unique_key:'A',hold_flag:true})).status,200);
  else if(kind==='carrier') assert.equal((await patch(carrier,{unique_key:'A',carrier:(await read('order:A')).carrier==='yamato'?'sagawa':'yamato'})).status,200);
  else if(kind==='bundle') {
   const id=(await read('order_snapshot:A')).bundle_group_id;
   const b=await read('bundle:'+id); b.order_unique_keys.push('OTHER');
   await redis.set('bundle:'+id,JSON.stringify(b));
  } else if(kind==='snapshot-delete') await redis.del('order_snapshot:A');
  else if(kind==='snapshot-wrongtype') {await redis.del('order_snapshot:A');await redis.sadd('order_snapshot:A','wrongtype');}
  else {const s=await read('order_snapshot:A');s.remark+='changed';await redis.set('order_snapshot:A',JSON.stringify(s));}
  return atomic(...args);
 };
 const result=await start(cycle); redis.fencedStartSession=atomic;
 assert.equal(result.status,409,kind);
 assert.equal(await redis.get('session:current'),null,kind);
 assert.equal(await redis.get(candidate),null,kind);
 assert.equal(await redis.getRawString('orders:refetch_state'),stateRaw,kind);count++;
}

// B: request already in flight, but its U1 SET commits AFTER session creation.
for(const kind of ['hold','carrier']) {
 const cycle=await ready();
 const set=redis.set.bind(redis); let entered,release;
 const blocked=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 redis.set=async(key,value,...rest)=>{if(key==='order:A'){entered();await gate;}return set(key,value,...rest);};
 const changing=kind==='hold'?patch(hold,{unique_key:'A',hold_flag:true}):patch(carrier,{unique_key:'A',carrier:(await read('order:A')).carrier==='yamato'?'sagawa':'yamato'});
 await blocked;
 assert.equal((await start(cycle)).status,200);
 const id=await redis.get('session:current'), s=await read('session:'+id);
 await set('session:'+id,JSON.stringify({...s,checklist_printed_flag:true,pdf_output_done_flag:true,
   csv_status:{sagawa:'done',yamato:'done',nekopos:'done'}}));
 release();assert.equal((await changing).status,200);redis.set=set;
 const updated=await read('session:'+id);
 assert.equal(updated.session_status,'active');assert.equal(updated.pdf_output_done_flag,false);
 assert.equal(updated.checklist_printed_flag,false,kind+' must reset checklist');
 assert.deepEqual(Object.values(updated.csv_status),['pending','pending','pending']);
 assert.equal(await redis.get('session:current'),id);assert.equal((await redis.keys('session:*')).length,2);count++;
}

// Success response lost: same POST cannot create a second session, GET exposes the committed one.
{
 const cycle=await ready();redis.fencedStartSession=async(...args)=>{await atomic(...args);throw new Error('lost response');};
 assert.notEqual((await start(cycle)).status,200);redis.fencedStartSession=atomic;
 const id=await redis.get('session:current');assert.ok(id);
 assert.equal((await start(cycle)).status,409);
 const shown=await current.GET(new Request('http://local/api/session/current'));
 assert.equal((await shown.json()).session.session_id,id);
 assert.equal((await redis.keys('session:*')).length,2);count++;
}

// Discovery changes must not add a new inspection target after final batch retrieval.
{
 const cycle=await ready();const batch=redis.getRawBatch.bind(redis);let calls=0;
 redis.getRawBatch=async keys=>{
  if(++calls===3){const s=await read('order_snapshot:A');s.remark+='discovery race';await redis.set('order_snapshot:A',JSON.stringify(s));}
  return batch(keys);
 };
 assert.equal((await start(cycle)).status,409);assert.equal(calls,3);redis.getRawBatch=batch;count++;
}

// Memory/raw transport rejects every bounded-read error without silently omitting a key.
{
 const r=new MemoryRedis();const raw=' { "name":"界\\n\\\"", "n": 1 } ';
 await r.set('one',raw);assert.deepEqual(await r.getRawBatch(['one']),[raw]);
 for(const keys of [[],['one','one'],Array.from({length:301},(_,i)=>'k'+i),['one','missing']]) await assert.rejects(r.getRawBatch(keys));
 await r.sadd('set','x');await assert.rejects(r.getRawBatch(['one','set']));
 await r.set('large','界'.repeat(22000));await assert.rejects(r.getRawBatch(['large']),/VALUE_LIMIT/);
 const keys=Array.from({length:9},(_,i)=>'total'+i);for(const key of keys)await r.set(key,'x'.repeat(65536));
 await assert.rejects(r.getRawBatch(keys),/TOTAL_LIMIT/);
 for(const key of keys.slice(0,8))await r.set(key,'"'.repeat(65536));
 await assert.rejects(r.getRawBatch(keys.slice(0,8)),/RESPONSE_LIMIT/);
 const dev=createDevelopmentRedis(r);await dev.set('raw',raw);assert.deepEqual(await dev.getRawBatch(['raw']),[raw]);
 assert.equal(await r.get(DEVELOPMENT_REDIS_NAMESPACE+'raw'),raw);
 assert.throws(()=>dev.getRawBatch(['dev:forbidden']));
 let captured;
 const pipeline={eval(script,keys,args){captured={script,keys,args};return this;},async exec(){return ['RAW:'+JSON.stringify([raw])];}};
 const adapter=new UpstashRedisAdapter({pipeline:()=>pipeline});
 assert.deepEqual(await adapter.getRawBatch(['one']),[raw]);assert.equal(captured.script,RAW_BATCH_SCRIPT);
 pipeline.exec=async()=>[[JSON.parse(raw)]];await assert.rejects(adapter.getRawBatch(['one']),/RAW_RESPONSE/);
 pipeline.exec=async()=>[1];await adapter.fencedStartSession('lease','owner','current','id','candidate',{active:true},'state');
 assert.equal(captured.script,SESSION_START_SCRIPT);count++;
}

// Payload/type/size rejection occurs before the first session write.
{
 const r=new MemoryRedis();await r.set('lease','owner');await r.set('state','unchanged');
 for(const guards of [[{key:'a',expected:'x'},{key:'a',expected:'x'}],[{key:'a',expected:'x'.repeat(524289)}],
   [{key:'a',expected:'"'.repeat(300000)}]]) {
  await assert.rejects(r.fencedStartSession('lease','owner','current','id','candidate',{active:true},'state',guards));
  assert.equal(await r.get('candidate'),null);assert.equal(await r.get('current'),null);assert.equal(await r.get('state'),'unchanged');
 }
 await r.set('candidate','existing');await assert.rejects(r.fencedStartSession('lease','owner','current','id','candidate',{active:true},'state'));
 assert.equal(await r.get('candidate'),'existing');assert.equal(await r.get('current'),null);count++;
}

// Actual session command metrics for both 100-order shapes; no real Redis or API.
for(const manyBundles of [false,true]) {
 const orders=Array.from({length:100},(_,i)=>{
  const o=order('MAX_'+String(i).padStart(3,'0'),'shared');
  if(manyBundles)o.ordered+=i*86400;return o;
 });
 await reset(orders);await fetchCurrent();const cycle=await confirm();let metrics;
 redis.fencedStartSession=async(...args)=>{
  const [lease,owner,cur,id,candidate,value,state,guards]=args;
  const e=encodeSessionStart([lease,cur,candidate,state],owner,id,typeof value==='string'?value:JSON.stringify(value),guards);
  metrics={orders:100,bundles:manyBundles?100:1,key_count:e.keys.length,guard_count:guards.length,
    raw_bytes:e.rawBytes,encoded_request_bytes:e.bytes};return atomic(...args);
 };
 const ids=manyBundles?orders.map(o=>o.unique_key):[orders[0].unique_key];
 const response=await start(cycle,ids);redis.fencedStartSession=atomic;
 assert.equal(response.status,200,JSON.stringify(await response.json()));
 assert.equal(metrics.key_count,manyBundles?306:207);console.log('SESSION_METRICS '+JSON.stringify(metrics));count++;
}
assert.equal(typeof store.readSessionStartEvidence,'function');
console.log('session atomic: '+count+' scenarios passed; A/B, raw bounds, replay, 100-order profiles (no network)');

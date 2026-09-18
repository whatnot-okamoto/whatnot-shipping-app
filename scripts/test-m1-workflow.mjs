import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
process.env.APP_ENVIRONMENT = 'local'; process.env.BASE_DATA_MODE = 'mock'; process.env.APP_STORE_MODE = 'memory';
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const { redis } = await import('../lib/upstash.ts');
const { initializeOrderData, generateBundleGroupId } = await import('../lib/order-store.ts');
const { FIXTURE_DATA } = await import('../lib/pdf-fixture-data.ts');
const fake = await import('./fakes/workflow-base-api.ts');
const refetch = await import('../app/api/orders/refetch/route.ts');
const diff = await import('../app/api/orders/diff-confirm/route.ts');
const init = await import('../app/api/orders/init/route.ts');
const start = await import('../app/api/session/start/route.ts');
const list = await import('../app/api/orders/list/route.ts');
const { applyMigration } = await import('./migrations/diff-modal-01-v1.ts');
const { pendingKey, readWorkflowContext, assertPublishedContext,
  failRefetchAttempt, beginRefetchAttempt } = await import('../lib/refetch-store.ts');
const { acquireWorkflowLease } = await import('../lib/workflow-operation-lease.ts');
const read = async key => { const raw = await redis.get(key); return typeof raw === 'string' ? JSON.parse(raw) : raw; };
const post = (route, body) => route.POST(new Request('http://local/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
function order(id, group = id) {
  const o = structuredClone(FIXTURE_DATA['F-01'].order); o.unique_key = id;
  o.ordered += [...group].reduce((n, c) => n + c.charCodeAt(0), 0) * 86400;
  o.dispatch_status = 'ordered'; o.dispatched = null; o.terminated = false;
  o.order_items[0].order_item_id = [...id].reduce((n, c) => n * 31 + c.charCodeAt(0), 1);
  o.shipping_lines[0].order_item_ids = [String(o.order_items[0].order_item_id)];
  o.shipping_lines[0].shipping_method = '宅配便'; return o;
}
async function setup(orders, initialized = orders) {
  await redis.del(...await redis.keys('*'));
  const source = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, order_results: { OLD: { status: 'not_in_open_orders', issues: [] } } });
  await redis.set('orders:refetch_state', source); await redis.set('orders:workflow_operation_lease', 'migration-owner');
  await redis.set('order_snapshot_pending:OLD', 'preserved'); await redis.sadd('index:order_snapshot_pending', 'OLD');
  await applyMigration(redis, { expectedFingerprint: createHash('sha256').update(source).digest('hex'), leaseValue: 'migration-owner' });
  await redis.del('orders:workflow_operation_lease');
  if (initialized.length) await initializeOrderData(initialized);
  fake.setWorkflowBaseOrders(orders);
}
async function request() {
  const response = await refetch.GET(new Request('http://local/api/orders/refetch'));
  assert.equal(response.status, 200);
  const context = await response.json();
  return { request_id: randomUUID(), workflow_epoch: context.workflow_epoch,
    source_cycle_id: context.source_cycle_id, source_publication_revision: context.source_publication_revision,
    previous_attempt_id: context.previous_attempt_id };
}
async function fetchCurrent() {
  const body = await request(); const response = await post(refetch, body); const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); return { body, result };
}
async function confirm() {
  const state = await read('orders:refetch_state'); const response = await post(diff, { refetch_cycle_id: state.refetch_cycle_id });
  assert.equal(response.status, 200, JSON.stringify(await response.json())); return state.refetch_cycle_id;
}
async function session(ids, cycle) { return post(start, { selected_unique_keys: ids, refetch_cycle_id: cycle }); }
let scenarios = 0;

// Failure never revives a previously confirmed cycle, even if failure recording is lost.
for (const loseFailure of [false, true]) {
  await setup([order('A')]); await fetchCurrent(); const oldCycle = await confirm();
  const oldRaw = await redis.getRawString('orders:refetch_state');
  fake.setWorkflowOrderListFailure(new Error('synthetic failure'));
  const original = redis.workflowMset.bind(redis);
  if (loseFailure) redis.workflowMset = async (guards, writes) => {
    if (writes.some(w => w.key === 'orders:refetch_attempt' && JSON.parse(w.value).status === 'failed')) throw new Error('failure record lost');
    return original(guards, writes);
  };
  const failed = await post(refetch, await request()); assert.equal(failed.status, 409);
  redis.workflowMset = original;
  assert.equal(await redis.getRawString('orders:refetch_state'), oldRaw);
  assert.equal((await read('orders:refetch_attempt')).status, loseFailure ? 'running' : 'failed');
  assert.equal((await session(['A'], oldCycle)).status, 409);
  fake.setWorkflowOrderListFailure(null);
  await fetchCurrent(); assert.equal((await session(['A'], oldCycle)).status, 409);
  const next = await confirm(); assert.equal((await session(['A'], next)).status, 200);
  scenarios++;
}

// Process disappearance / expired owner / stale failure update / explicit retry.
await setup([order('A')]); await fetchCurrent(); const oldCycle = await confirm();
const input = await request(); const lease = await acquireWorkflowLease('refetch', oldCycle);
await beginRefetchAttempt(input, lease); await redis.del('orders:workflow_operation_lease');
assert.equal((await session(['A'], oldCycle)).status, 409);
await fetchCurrent(); const currentAttempt = await redis.getRawString('orders:refetch_attempt');
await failRefetchAttempt(input.request_id, lease, 'refetch_failed');
assert.equal(await redis.getRawString('orders:refetch_attempt'), currentAttempt);
scenarios++;

// Response loss AFTER one MSET is publication, never a failed attempt.
await setup([order('A')]);
const original = redis.workflowMset.bind(redis);
let lost = false;
redis.workflowMset = async (guards, writes) => {
  const ok = await original(guards, writes);
  if (!lost && writes.some(w => w.key === 'orders:refetch_attempt' && JSON.parse(w.value).status === 'published')) {
    lost = true; throw new Error('response lost');
  }
  return ok;
};
const lostRequest = await request(); assert.equal((await post(refetch, lostRequest)).status, 409);
redis.workflowMset = original;
assert.equal((await read('orders:refetch_attempt')).status, 'published');
assert.equal((await post(refetch, lostRequest)).status, 200);
assert.equal((await post(refetch, { ...lostRequest, source_publication_revision: 99 })).status, 409);
assert.equal((await refetch.GET(new Request('http://local/api/orders/refetch?request_id=' + lostRequest.request_id))).status, 200);
scenarios++;

// Old pending and same-ID new pending coexist; missing current pending is not complete.
await setup([order('A')]); await redis.set('order_snapshot_pending:A', 'old-A');
await redis.sadd('index:order_snapshot_pending', 'A'); await fetchCurrent();
let state = await read('orders:refetch_state');
assert.equal(await redis.get('order_snapshot_pending:A'), 'old-A');
assert.ok(await redis.get(pendingKey(state.workflow_epoch, 'A')));
await redis.del(pendingKey(state.workflow_epoch, 'A'));
assert.equal((await post(diff, { refetch_cycle_id: state.refetch_cycle_id })).status, 409);
assert.equal((await session(['A'], state.refetch_cycle_id)).status, 409); scenarios++;

// Promotion succeeds, delete/response fails: matching epoch+cycle+fingerprint resumes once.
await setup([order('A')]); await fetchCurrent();
const mutate = redis.fencedMutate.bind(redis);
redis.fencedMutate = async () => { throw new Error('pending delete failed'); };
state = await read('orders:refetch_state');
assert.equal((await post(diff, { refetch_cycle_id: state.refetch_cycle_id })).status, 409);
redis.fencedMutate = mutate;
assert.ok(await redis.get(pendingKey(state.workflow_epoch, 'A')));
await confirm(); assert.equal((await session(['A'], state.refetch_cycle_id)).status, 200); scenarios++;

// An inconsistent old U2 is held, while an independent healthy U2 can start.
const a = order('A', 'same'), b = order('B', 'same'), c = order('C', 'other');
await setup([a, c], [a, b, c]);
const bundleBefore = await redis.getRawString('bundle:' + generateBundleGroupId(a));
await fetchCurrent(); const cycle = await confirm();
assert.equal((await session(['A'], cycle)).status, 409);
assert.equal(await redis.getRawString('bundle:' + generateBundleGroupId(a)), bundleBefore);
assert.equal((await session(['C'], cycle)).status, 200); scenarios++;

// New failed details remain visible; initialization + auto-refetch grants no early confirmation.
await setup([order('NEW')], []);
const unobserved = await readWorkflowContext();
assert.throws(() => assertPublishedContext(unobserved));
fake.setWorkflowFetchFailures(['NEW']); await fetchCurrent();
let displayed = await list.GET(new Request('http://local/api/orders/list'));
assert.equal(displayed.status, 200); assert.equal((await displayed.json()).orders.length, 1);
await confirm(); fake.setWorkflowFetchFailures([]); await fetchCurrent();
state = await read('orders:refetch_state'); assert.equal(state.has_new_uninitialized, true);
assert.equal((await session(['NEW'], state.refetch_cycle_id)).status, 409);
const initialized = await post(init, { refetch_cycle_id: state.refetch_cycle_id });
assert.equal(initialized.status, 200, JSON.stringify(await initialized.json()));
await fetchCurrent(); const newCycle = await confirm();
assert.equal((await session(['NEW'], newCycle)).status, 200); scenarios++;

// A healthy existing U2 accepts a newly initialized CURRENT member, preserving operations.
await setup([a, b], [a]);
const bundleKey = 'bundle:' + generateBundleGroupId(a);
const previousBundle = await read(bundleKey);
await redis.set(bundleKey, JSON.stringify({ ...previousBundle, bundle_enabled: false, tracking_number: 'SYNTHETIC-TRACK' }));
await fetchCurrent(); state = await read('orders:refetch_state');
assert.deepEqual(state.held_bundle_order_keys, []);
assert.deepEqual(state.initialization_keys, ['B']);
assert.equal((await post(init, { refetch_cycle_id: state.refetch_cycle_id })).status, 200);
const supplemented = await read(bundleKey);
assert.deepEqual(new Set(supplemented.order_unique_keys), new Set(['A', 'B']));
assert.equal(supplemented.bundle_enabled, false); assert.equal(supplemented.tracking_number, 'SYNTHETIC-TRACK');
await fetchCurrent(); const joinedCycle = await confirm();
assert.equal((await session(['A'], joinedCycle)).status, 200); scenarios++;

// Maximum supported current set: measure the actual publication command, then confirm/start.
const maximum = Array.from({ length: 100 }, (_, i) => order('MAX_' + i, 'one-current-bundle'));
await setup(maximum);
const { encodeWorkflowMset } = await import('../lib/redis-like.ts');
let publicationMetrics;
redis.workflowMset = async (guards, writes) => {
  if (writes.some(w => w.key === 'orders:refetch_attempt' && JSON.parse(w.value).status === 'published')) {
    const encoded = encodeWorkflowMset(guards, writes);
    publicationMetrics = { writes: writes.length, keys: encoded.keys.length, request_bytes: encoded.bytes,
      value_bytes: writes.reduce((n, w) => n + Buffer.byteLength(w.value), 0) };
  }
  return original(guards, writes);
};
await fetchCurrent(); redis.workflowMset = original;
assert.equal(publicationMetrics.writes, 103); assert.equal(publicationMetrics.keys, 106);
const maxCycle = await confirm(); assert.equal((await session(['MAX_0'], maxCycle)).status, 200);
assert.equal(await redis.getRawString('orders:refetch_state'), null);
console.log('M1 maximum synthetic publication: ' + JSON.stringify(publicationMetrics)); scenarios++;

console.log('M1 real routes / Memory Redis: ' + scenarios + ' scenarios passed (network forbidden)');

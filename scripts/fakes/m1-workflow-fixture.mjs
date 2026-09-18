// Synthetic, memory-only fixture. Never imports credentials or opens a connection.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
process.env.APP_ENVIRONMENT = 'local'; process.env.BASE_DATA_MODE = 'mock'; process.env.APP_STORE_MODE = 'memory';
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
export const { redis } = await import('../../lib/upstash.ts');
export const store = await import('../../lib/order-store.ts');
export const refetch = await import('../../app/api/orders/refetch/route.ts');
export const diff = await import('../../app/api/orders/diff-confirm/route.ts');
export const init = await import('../../app/api/orders/init/route.ts');
export const session = await import('../../app/api/session/start/route.ts');
export const list = await import('../../app/api/orders/list/route.ts');
export const fake = await import('./workflow-base-api.ts');
export const stateStore = await import('../../lib/refetch-store.ts');
export const leases = await import('../../lib/workflow-operation-lease.ts');
const { FIXTURE_DATA } = await import('../../lib/pdf-fixture-data.ts');
const { applyMigration } = await import('../migrations/diff-modal-01-v1.ts');
export const post = (route, body) => route.POST(new Request('http://local/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
export const read = async key => { const raw = await redis.get(key); return typeof raw === 'string' ? JSON.parse(raw) : raw; };
export function order(id, group = id) {
  const o = structuredClone(FIXTURE_DATA['F-01'].order); o.unique_key = id;
  o.ordered += [...group].reduce((n, c) => n + c.charCodeAt(0), 0) * 86400;
  o.dispatch_status = 'ordered'; o.dispatched = null; o.terminated = false;
  o.order_items[0].order_item_id = [...id].reduce((n, c) => n * 31 + c.charCodeAt(0), 1);
  o.shipping_lines[0].order_item_ids = [String(o.order_items[0].order_item_id)];
  o.shipping_lines[0].shipping_method = '宅配便'; return o;
}
export async function reset(orders = [order('A')], initialized = orders) {
  assert.equal(process.env.APP_STORE_MODE, 'memory');
  const keys = await redis.keys('*'); if (keys.length) await redis.del(...keys);
  const legacy = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, order_results: {} });
  await redis.set('orders:refetch_state', legacy); await redis.set('orders:workflow_operation_lease', 'fixture');
  await applyMigration(redis, { expectedFingerprint: createHash('sha256').update(legacy).digest('hex'), leaseValue: 'fixture' });
  await redis.del('orders:workflow_operation_lease');
  if (initialized.length) await store.initializeOrderData(initialized);
  fake.setWorkflowBaseOrders(orders);
}
export async function request() {
  const r = await refetch.GET(new Request('http://local/api/orders/refetch'));
  assert.equal(r.status, 200); const c = await r.json();
  return { request_id: randomUUID(), workflow_epoch: c.workflow_epoch, source_cycle_id: c.source_cycle_id,
    source_publication_revision: c.source_publication_revision, previous_attempt_id: c.previous_attempt_id };
}
export async function fetchCurrent() {
  const input = await request(); const r = await post(refetch, input); const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data)); return { input, data, state: await read('orders:refetch_state') };
}
export async function confirm() {
  const state = await read('orders:refetch_state'); const r = await post(diff, { refetch_cycle_id: state.refetch_cycle_id });
  assert.equal(r.status, 200, JSON.stringify(await r.json())); return state.refetch_cycle_id;
}

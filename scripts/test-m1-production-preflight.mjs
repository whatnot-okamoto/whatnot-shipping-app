// No real credentials or network. The SDK is exercised only with a synthetic fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MemoryRedis } from '../lib/memory-redis.ts';
import { createDevelopmentRedis, createProductionRedis } from '../lib/namespaced-redis.ts';
import { createProductionPreflight, maintenanceWindow, safeResult, EXPECTED_FINGERPRINT, SOURCE_LIMIT } from '../lib/m1-production-preflight.ts';
let count = 0, network = 0;
globalThis.fetch = async () => { network++; throw new Error('NETWORK_FORBIDDEN'); };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const raw = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, phase: 'promoting',
  order_results: { PRIVATE_ORDER: { note: 'PRIVATE_RAW_SECRET' } } });
const keys = ['orders:workflow_epoch', 'orders:migration:diff-modal-01:v1', 'session:current',
  'orders:workflow_operation_lease', 'orders:refetch_attempt'];
const window = '2026-09-19T00:00:00.000Z/2026-09-19T00:30:00.000Z';
const time = Date.parse('2026-09-19T00:10:00.000Z');
const request = (options = {}) => new Request('https://synthetic.invalid/api/maintenance/m1-v1/preflight', {
  method: 'POST', headers: { origin: 'https://synthetic.invalid', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
  body: '{}', ...options });
async function fixture(options = {}) {
  const memory = new MemoryRedis(); await memory.set('orders:refetch_state', raw);
  const reads = []; let creations = 0;
  const reader = {
    async exists(key) { reads.push(key); await options.before?.(reads.length, memory); return memory.exists(key); },
    async getRawString(key, limit) { assert.equal(limit, SOURCE_LIMIT); reads.push(key); await options.before?.(reads.length, memory); return memory.getRawString(key, limit); },
  };
  const deps = { expectedFingerprint: sha(raw), requireAuth: async () => null, production: () => true,
    window: () => window, now: () => time, origin: () => 'https://synthetic.invalid',
    reader: async () => { creations++; return reader; }, ...options.deps };
  return { memory, reader, reads, deps, created: () => creations, routes: createProductionPreflight(deps) };
}
async function test(name, fn) {
  const log = console.log, error = console.error, warn = console.warn, captured = [];
  console.log = console.error = console.warn = (...args) => captured.push(args);
  try { await fn(); assert.deepEqual(captured, [], `${name}: unexpected log`); count++; }
  finally { console.log = log; console.error = error; console.warn = warn; }
}
async function result(f, req = request()) {
  const response = await f.routes.POST(req); const text = await response.text();
  assert.ok(!text.includes('PRIVATE_')); assert.ok(!text.includes('synthetic.invalid'));
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('vary'), 'Cookie');
  const value = JSON.parse(text); assert.equal(safeResult(value), true);
  return { status: response.status, ...value };
}
await test('normal exact before/after and fixed read sequence', async () => {
  const f = await fixture(); const r = await result(f);
  assert.equal(r.result, 'checked'); assert.equal(r.logical_reads, 12); assert.equal(r.before_after_match, true);
  assert.deepEqual(f.reads, [...keys, 'orders:refetch_state', 'orders:refetch_state', ...keys]);
  assert.equal(await f.memory.getRawString('orders:refetch_state'), raw);
});
for (const [name, deps, status] of [
  ['auth missing', { requireAuth: async () => new Response('PRIVATE_AUTH') }, 401],
  ['auth throws', { requireAuth: async () => { throw new Error('PRIVATE_AUTH'); } }, 404],
  ['preview', { production: () => false }, 404], ['bad runtime', { production: () => { throw 'PRIVATE_RUNTIME'; } }, 404],
  ['window missing', { window: () => undefined }, 404], ['window expired', { now: () => time + 3600000 }, 404],
  ['not yet open', { now: () => time - 3600000 }, 404], ['bad fingerprint config', { expectedFingerprint: 'PRIVATE_INPUT' }, 404],
]) await test(name, async () => {
  const f = await fixture({ deps }); assert.equal((await result(f)).status, status); assert.equal(f.created(), 0); assert.equal(f.reads.length, 0);
  assert.equal((await f.routes.GET(new Request('https://synthetic.invalid/maintenance/m1-v1'))).status, status);
});
for (const value of [undefined, '', 'PRIVATE_BAD', window + '/extra',
  '2026-02-30T00:00:00.000Z/2026-02-30T00:10:00.000Z',
  '2026-09-19T00:30:00.000Z/2026-09-19T00:00:00.000Z',
  '2026-09-19T00:00:00.000Z/2026-09-19T01:00:00.000Z'])
  await test('invalid window', () => assert.equal(maintenanceWindow(value, time), false));
await test('window inclusive start exclusive end', () => {
  assert.equal(maintenanceWindow(window, Date.parse(window.split('/')[0])), true);
  assert.equal(maintenanceWindow(window, Date.parse(window.split('/')[1])), false);
});
for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) await test(`method ${method}`, async () => {
  const f = await fixture(); assert.equal((await result(f, request({ method, body: undefined }))).status, 405);
  assert.equal(f.created(), 0);
});
for (const headers of [ {}, { origin: 'https://other.invalid' }, { 'sec-fetch-site': 'cross-site' },
  { 'content-type': 'text/plain' }, { 'content-length': '999999' }]) await test('input headers', async () => {
  const f = await fixture(); const base = headers.origin === undefined && Object.keys(headers).length === 0 ? {} :
    { origin: 'https://synthetic.invalid', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers };
  assert.equal((await result(f, request({ headers: base }))).status, 400); assert.equal(f.created(), 0);
});
for (const body of ['', '[]', 'null', '{ }', '{"key":"PRIVATE_INPUT"}', 'x'.repeat(4096)]) await test('fixed two-byte input', async () => {
  const f = await fixture(); assert.equal((await result(f, request({ body }))).status, 400); assert.equal(f.created(), 0);
});
for (const [i, key] of keys.entries()) {
  await test(`presence before ${i}`, async () => {
    const f = await fixture(); await f.memory.set(key, 'PRIVATE_VALUE');
    const r = await result(f); assert.equal(r.reason, 'present'); assert.equal(f.reads.length, i + 1);
    assert.ok(!f.reads.includes('orders:refetch_state'));
  });
  await test(`presence after ${i}`, async () => {
    const f = await fixture({ before: async (n, m) => { if (n === 7) await m.set(key, 'PRIVATE_VALUE'); } });
    const r = await result(f); assert.equal(r.result, 'indeterminate'); assert.equal(r.reason, 'changed');
    assert.equal(r.before_after_match, false); assert.equal(f.reads.length, 8 + i);
  });
}
for (const value of [null, '[]', '{}', '{', '{"refetch_done_flag":true,"diff_confirmed_flag":1}', 'x'.repeat(SOURCE_LIMIT + 1)])
  await test('source rejects missing invalid oversized', async () => {
    const f = await fixture(); if (value === null) await f.memory.del('orders:refetch_state'); else await f.memory.set('orders:refetch_state', value);
    const r = await result(f); assert.notEqual(r.result, 'checked'); assert.equal(f.reads.length, 6);
  });
await test('wrong type source', async () => {
  const f = await fixture(); await f.memory.del('orders:refetch_state'); await f.memory.sadd('orders:refetch_state', 'PRIVATE_ITEM');
  assert.equal((await result(f)).reason, 'read_failed'); assert.equal(f.reads.length, 6);
});
for (const phase of ['PRIVATE_UNKNOWN_PHASE', null, 7]) await test('unknown phase before fingerprint mismatch', async () => {
  const f = await fixture(); await f.memory.set('orders:refetch_state', JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: true, phase }));
  const r = await result(f); assert.equal(r.result, 'indeterminate'); assert.equal(r.reason, 'phase'); assert.equal(r.fingerprint_match, false);
});
await test('fingerprint mismatch', async () => {
  const f = await fixture(); await f.memory.set('orders:refetch_state', raw + ' ');
  assert.equal((await result(f)).reason, 'fingerprint'); assert.equal(f.reads.length, 6);
});
for (const phase of ['requires_refetch', 'awaiting_initialization', 'awaiting_review', 'postprocessing', 'confirmed', undefined])
  await test('known or missing historical phase with independent expected hash', async () => {
    const value = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, phase });
    const f = await fixture({ deps: { expectedFingerprint: sha(value) } }); await f.memory.set('orders:refetch_state', value);
    const r = await result(f); assert.equal(r.result, 'checked'); assert.equal(r.phase, phase ?? 'missing');
  });
await test('no mutation capability or BASE/token dependency is supplied', async () => {
  const f = await fixture(); const calls = [];
  f.deps.reader = async () => new Proxy(f.reader, { get(target, prop) {
    if (prop === 'then') return undefined;
    assert.ok(['exists', 'getRawString'].includes(prop)); calls.push(prop); return target[prop];
  } });
  f.routes = createProductionPreflight(f.deps);
  assert.equal((await result(f)).result, 'checked'); assert.equal(calls.length, 12);
});
for (const value of [null, raw + ' ', '{"PRIVATE_DIFFERENT":true}']) await test('source after differs', async () => {
  const f = await fixture({ before: async (n, m) => {
    if (n === 7) { if (value === null) await m.del('orders:refetch_state'); else await m.set('orders:refetch_state', value); }
  } });
  const r = await result(f); assert.equal(r.reason, 'changed'); assert.equal(r.before_after_match, false); assert.equal(f.reads.length, 7);
});
for (const bad of [new Error('PRIVATE_EXCEPTION'), Object.defineProperty({}, 'message', { get() { throw 'PRIVATE_GETTER'; } }),
  new Proxy({}, { get() { throw 'PRIVATE_PROXY'; } })]) await test('read exceptions never inspected or logged', async () => {
    const f = await fixture({ before: () => { throw bad; } }); assert.equal((await result(f)).reason, 'read_failed'); assert.equal(f.reads.length, 1);
  });
await test('abort while awaiting read stops remaining reads', async () => {
  const controller = new AbortController(); const f = await fixture({ before: async () => { controller.abort(); await new Promise(() => {}); } });
  const r = await result(f, request({ signal: controller.signal })); assert.equal(r.reason, 'timeout'); assert.equal(f.reads.length, 1);
});
await test('window expires during read', async () => {
  let tick = time; const f = await fixture({ before: () => { tick += 3600000; }, deps: { now: () => tick } });
  assert.equal((await result(f)).reason, 'read_failed'); assert.equal(f.reads.length, 1);
});
await test('overall timeout bounds a stalled read without retry', async () => {
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 120000 ? 5 : ms, ...args);
  try {
    const f = await fixture({ before: async () => new Promise(() => {}) });
    const r = await result(f); assert.equal(r.reason, 'timeout'); assert.equal(f.reads.length, 1);
  } finally { globalThis.setTimeout = originalTimer; }
});
await test('invalid exists result is indeterminate', async () => {
  const f = await fixture(); f.reader.exists = async () => 'PRIVATE_VALUE'; assert.equal((await result(f)).reason, 'read_failed');
});
await test('Memory/namespace presence including set, expiry and forbidden prefix', async () => {
  let now = 0; const m = new MemoryRedis(() => now); const dev = createDevelopmentRedis(m); const prod = createProductionRedis(m);
  await dev.set('session:current', 'PRIVATE_ID', { ex: 1 }); assert.equal(await dev.exists('session:current'), 1);
  assert.equal(await prod.exists('session:current'), 0); now = 1001; assert.equal(await dev.exists('session:current'), 0);
  await m.sadd('session:current', 'PRIVATE_ID'); assert.equal(await prod.exists('session:current'), 1);
  await assert.rejects(async () => prod.exists('dev:v1:session:current'));
});
await test('page has no reads, one manual request, safe rendering and no external assets', async () => {
  const f = await fixture(); const res = await f.routes.GET(new Request('https://synthetic.invalid/maintenance/m1-v1'));
  const html = await res.text(); assert.equal(f.created(), 0); assert.ok(res.headers.get('content-security-policy').includes("default-src 'none'"));
  assert.ok(!html.includes(EXPECTED_FINGERPRINT)); assert.ok(!/<(?:script[^>]*src|link|img)/i.test(html));
  const js = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  let callback, calls = 0; const output = { textContent: '' }; const button = { disabled: false, addEventListener: (_event, fn) => { callback = fn; } };
  const normal = await result(await fixture()); delete normal.status;
  const context = { document: { getElementById: id => id === 'run' ? button : output }, AbortSignal,
    fetch: async (_url, options) => { calls++; assert.equal(options.method, 'POST'); assert.equal(options.body, '{}'); return new Response(JSON.stringify(normal)); } };
  vm.runInNewContext(js, context); assert.equal(calls, 0); await callback.call(button); assert.equal(calls, 1); assert.equal(button.disabled, true);
  assert.equal(JSON.parse(output.textContent).result, 'checked');
  context.fetch = async () => new Response(JSON.stringify({ ...normal, unknown: 'PRIVATE_VALUE' }));
  await callback.call(button); assert.ok(!output.textContent.includes('PRIVATE_VALUE')); assert.ok(!output.textContent.startsWith('{'));
});
await test('output unknown/getter fields rejected', async () => {
  const normal = await result(await fixture()); delete normal.status;
  assert.equal(safeResult({ ...normal, unknown: 'PRIVATE_VALUE' }), false);
  assert.equal(safeResult({ ...normal, before_after_match: false }), false);
  assert.equal(safeResult(Object.defineProperty({ ...normal }, 'phase', { get() { throw 'PRIVATE_VALUE'; } })), false);
});
await test('runtime boundary has no CLI transport BASE or write imports', () => {
  const code = readFileSync(new URL('../lib/m1-production-preflight-runtime.ts', import.meta.url), 'utf8');
  assert.ok(!/base-api|migration|m1-readonly-transport|check-m1-fixed/.test(code));
  assert.match(code, /expectedFingerprint: EXPECTED_FINGERPRINT/);
});
assert.equal(network, 0);

// Use the actual SDK and Production adapter with synthetic settings/fetch only.
process.env.APP_ENVIRONMENT = 'production'; process.env.BASE_DATA_MODE = 'production'; process.env.APP_STORE_MODE = 'upstash';
process.env.VERCEL_ENV = 'production'; process.env.UPSTASH_REDIS_REST_URL = 'https://synthetic.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'SYNTHETIC_TOKEN';
const { createM1ProductionReader } = await import('../lib/upstash.ts');
await test('SDK native EXISTS and existing single-key raw reader', async () => {
  const calls = []; globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body); calls.push(command);
    return new Response(JSON.stringify({ result: command[0].toLowerCase() === 'exists' ? 0 : 'RAW:' + raw }));
  };
  const reader = createM1ProductionReader(new AbortController().signal);
  assert.equal(await reader.exists(keys[0]), 0); assert.equal(await reader.getRawString('orders:refetch_state', SOURCE_LIMIT), raw);
  assert.deepEqual(Object.keys(reader).sort(), ['exists', 'getRawString']); assert.equal(calls.length, 2);
  assert.equal(calls[1][0].toLowerCase(), 'eval'); assert.equal(calls[1][2], 1); assert.ok(!calls[1][1].includes('cjson'));
});
await test('SDK retains 5 retries maximum 6 attempts on network errors', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('SYNTHETIC_NETWORK_ERROR'); };
  const reader = createM1ProductionReader(new AbortController().signal);
  await assert.rejects(reader.exists(keys[0])); assert.equal(calls, 6);
});
await test('SDK abort stops retry without real network', async () => {
  let calls = 0; const controller = new AbortController(); globalThis.fetch = async () => { calls++; controller.abort(); throw new Error('SYNTHETIC_ABORT'); };
  await assert.rejects(createM1ProductionReader(controller.signal).exists(keys[0])); assert.equal(calls, 1);
});
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
console.log(`M1 Production preflight: ${count} scenarios passed (synthetic only / real network 0)`);

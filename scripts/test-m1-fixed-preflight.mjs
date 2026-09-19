// Synthetic responses only. No SDK client, dotenv or real Redis.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FIXED_KEYS, FIXED_LUA, HTTP_MS, RESPONSE_BYTES, observeFixedKeys } from './m1-readonly-transport.mjs';
import { main, runCli, classifyObservation, validateFixedResult, TOOL_MS } from './check-m1-fixed-preflight.mjs';
let realFetchCalls = 0;
globalThis.fetch = async () => { realFetchCalls++; throw new Error('NETWORK_FORBIDDEN'); };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const source = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, phase: 'promoting',
  order_results: { PRIVATE_ORDER_SENTINEL: { note: '日本語\\"\n' } } });
const fingerprint = sha(source);
const fresh = (raw = source) => ({ types: ['none', 'none', 'string', 'none', 'none', 'none'],
  lengths: [null, null, Buffer.byteLength(raw), null, null, null], ttl: -2, source: raw });
const response = value => new Response(JSON.stringify({ result: JSON.stringify(value) }), { status: 200 });
let count = 0;
async function test(name, action) { await action(); count++; /* names never contain real data */ }

await test('fixed vocabulary and source-only GET', () => {
  assert.deepEqual(FIXED_KEYS, ['orders:workflow_epoch', 'orders:migration:diff-modal-01:v1', 'orders:refetch_state',
    'session:current', 'orders:workflow_operation_lease', 'orders:refetch_attempt']);
  assert.deepEqual([...FIXED_LUA.matchAll(/redis\.call\('([A-Z]+)'/g)].map(m => m[1]).sort(), ['GET', 'PTTL', 'STRLEN', 'TYPE']);
  assert.match(FIXED_LUA, /redis\.call\('GET',KEYS\[3\]\)/);
  assert.match(FIXED_LUA, /#KEYS~=6 or #ARGV~=0/);
  assert.match(FIXED_LUA, /i>=3 and r\.types\[i\]=='string'/);
  assert.match(FIXED_LUA, /KEYS\[i\]~=expected\[i\]/);
  assert.match(FIXED_LUA, /r\.types\[1\]=='none' and r\.types\[2\]=='none'/);
});
await test('matching independent fingerprint', () => {
  const r = classifyObservation(fresh(), fingerprint);
  assert.equal(r.result, 'checked'); assert.equal(r.legacy_phase, 'promoting'); assert.equal(r.legacy_unfinished, true);
  assert.equal(r.fingerprint_match, true); assert.ok(!JSON.stringify(r).includes('PRIVATE_ORDER_SENTINEL'));
});
await test('different fingerprint', () => assert.equal(classifyObservation(fresh(), '0'.repeat(64)).result, 'blocked'));
for (const index of [0, 1, 3, 4, 5]) for (const type of ['string', 'hash']) {
  await test(`metadata-only ${index} ${type}`, () => {
    const o = fresh(); o.types[index] = type; o.lengths[index] = index >= 3 && type === 'string' ? 123 : null;
    if (index === 4) o.ttl = 90000;
    o.source = null;
    const r = classifyObservation(o, fingerprint);
    assert.equal(r.result, 'blocked'); assert.equal(r.source, 'not_read'); assert.equal(r.fingerprint_match, null);
    assert.equal(r[['epoch', 'migration_record', '', 'session_current', 'lease', 'attempt'][index]],
      type === 'string' ? 'unexpected_present' : 'invalid_type');
  });
}
for (const [type, ttl, expected] of [['none', -2, 'absent'], ['string', 1, 'positive'], ['string', -1, 'no_expiry'],
  ['none', 1, 'indeterminate'], ['none', -1, 'indeterminate'], ['string', -2, 'indeterminate'], ['string', 0, 'indeterminate']]) {
  await test(`lease ${type} ${ttl}`, () => {
    const o = fresh(); o.types[4] = type; o.lengths[4] = type === 'string' ? 100 : null; o.ttl = ttl;
    if (type !== 'none' || ttl !== -2) o.source = null;
    const r = classifyObservation(o, fingerprint); assert.equal(r.lease_ttl, expected);
    if (expected === 'indeterminate') assert.equal(r.result, 'indeterminate');
  });
}
for (const [type, size, expected] of [['none', null, 'missing'], ['hash', null, 'invalid_type'], ['string', 262145, 'too_large']]) {
  await test(`source ${expected}`, () => {
    const o = fresh(); o.types[2] = type; o.lengths[2] = size; o.source = null;
    assert.equal(classifyObservation(o, fingerprint).source, expected);
  });
}
for (const raw of ['{', 'null', '[]', '1', '"PRIVATE_ORDER_SENTINEL"', '{}', '{"refetch_done_flag":true}',
  '{"refetch_done_flag":1,"diff_confirmed_flag":false}']) {
  await test('shared legacy schema rejects invalid source', () => assert.equal(classifyObservation(fresh(raw), sha(raw)).source, 'invalid_schema'));
}
for (const phase of ['requires_refetch', 'awaiting_initialization', 'awaiting_review', 'promoting', 'postprocessing',
  'confirmed', 'SECRET_UNKNOWN_PHASE', undefined, null, 123]) {
  await test('phase projection', () => {
    const raw = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: true, phase });
    const r = classifyObservation(fresh(raw), sha(raw));
    assert.equal(r.legacy_phase, phase === undefined ? 'missing' : typeof phase !== 'string' ? 'invalid' :
      phase === 'SECRET_UNKNOWN_PHASE' ? 'unknown' : phase);
    assert.equal(r.legacy_unfinished, r.legacy_phase === 'confirmed' ? false :
      ['unknown', 'missing', 'invalid'].includes(r.legacy_phase) ? null : true);
    assert.ok(!JSON.stringify(r).includes('SECRET_UNKNOWN_PHASE'));
  });
}
for (const phase of ['SECRET_UNKNOWN_PHASE', null]) {
  await test('indeterminate phase takes precedence over fingerprint mismatch without raw output', async () => {
    const raw = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: true, phase,
      order_results: { PRIVATE_ORDER_SENTINEL: { note: 'PRIVATE_RAW_VALUE' } } });
    const result = await capture(async () => classifyObservation(fresh(raw), '0'.repeat(64)));
    assert.equal(result.code, 2); assert.deepEqual(result.err, []); assert.equal(result.out.length, 1);
    const output = JSON.parse(result.out[0]);
    assert.equal(Object.keys(output).length, 13);
    assert.equal(output.result, 'indeterminate'); assert.equal(output.fingerprint_match, false);
    assert.equal(output.legacy_phase, phase === null ? 'invalid' : 'unknown');
    assert.equal(output.legacy_unfinished, null);
    for (const forbidden of [raw, 'PRIVATE_ORDER_SENTINEL', 'PRIVATE_RAW_VALUE', 'SECRET_UNKNOWN_PHASE'])
      assert.ok(!result.out[0].includes(forbidden));
  });
}
for (const mutate of [o => o.types.pop(), o => o.lengths.push(null), o => o.ttl = 0.5,
  o => o.lengths[0] = 1, o => o.lengths[2]++, o => o.source = null,
  o => { o.types[0] = 'string'; }, o => o.extra = 'PRIVATE_ORDER_SENTINEL']) {
  await test('malformed or excessive raw response', () => { const o = fresh(); mutate(o); assert.throws(() => classifyObservation(o, fingerprint)); });
}

const argv = ['--url-env', 'M1_TEST_URL', '--token-env', 'M1_TEST_TOKEN', '--expected-fingerprint', fingerprint];
const prepare = () => { process.env.M1_TEST_URL = 'https://synthetic.invalid'; process.env.M1_TEST_TOKEN = 'SYNTHETIC_PRIVATE_TOKEN'; };
await test('one fetch, fixed ordered keys, redirect denied, env removed', async () => {
  prepare(); let calls = 0;
  const r = await main(argv, async (url, options) => {
    calls++; assert.equal(process.env.M1_TEST_URL, undefined); assert.equal(process.env.M1_TEST_TOKEN, undefined);
    assert.equal(url, 'https://synthetic.invalid'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), ['EVAL', FIXED_LUA, 6, ...FIXED_KEYS]);
    assert.ok(!options.body.includes('SYNTHETIC_PRIVATE_TOKEN')); return response(fresh());
  });
  assert.equal(calls, 1); assert.equal(r.result, 'checked');
});
for (const args of [[], [...argv, 'extra'], [...argv.slice(0, 4), '--expected-fingerprint', 'a'.repeat(63)],
  [...argv.slice(0, 4), '--expected-fingerprint', 'A'.repeat(64)], [...argv.slice(0, 4), '--expected-fingerprint', fingerprint + '\n'],
  ['--url', 'https://synthetic.invalid', ...argv.slice(2)], ['--url-env', 'M1_TEST_URL', '--token-env', 'M1_TEST_URL', ...argv.slice(4)]]) {
  await test('bad arguments before fetch', async () => { await assert.rejects(main(args, () => assert.fail('fetch forbidden')), /M1_PREFLIGHT_ARGUMENT/); });
}
for (const [url, token] of [[undefined, 'x'], ['', 'x'], ['http://synthetic.invalid', 'x'], ['https://synthetic.invalid?q=x', 'x'],
  ['https://user:pass@synthetic.invalid', 'x'], ['https://synthetic.invalid', undefined], ['https://synthetic.invalid', ''],
  ['https://synthetic.invalid', 'x\ny']]) {
  await test('bad credentials before fetch and consumed env removed', async () => {
    prepare(); if (url === undefined) delete process.env.M1_TEST_URL; else process.env.M1_TEST_URL = url;
    if (token === undefined) delete process.env.M1_TEST_TOKEN; else process.env.M1_TEST_TOKEN = token;
    await assert.rejects(main(argv, () => assert.fail('fetch forbidden')));
    assert.equal(process.env.M1_TEST_URL, undefined); assert.equal(process.env.M1_TEST_TOKEN, undefined);
  });
}
for (const makeResponse of [() => new Response('SECRET', { status: 302 }), () => new Response('SECRET', { status: 401 }),
  () => new Response('SECRET', { headers: { 'content-length': String(RESPONSE_BYTES + 1) } }),
  () => new Response('x'.repeat(RESPONSE_BYTES + 1)), () => new Response('{'),
  () => new Response(JSON.stringify({ error: 'SECRET' })),
  () => new Response(new ReadableStream({ pull(c) { c.error(new Error('SECRET')); } }))]) {
  await test('HTTP and bounded body failures no retry', async () => {
    let calls = 0;
    await assert.rejects(observeFixedKeys('https://synthetic.invalid', 'SYNTHETIC_PRIVATE_TOKEN', async () => { calls++; return makeResponse(); }));
    assert.equal(calls, 1);
  });
}
await test('maximum source escaping fits response cap', async () => {
  const raw = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, note: '\u0000'.repeat(20000) });
  const o = fresh(raw); const result = await observeFixedKeys('https://synthetic.invalid', 'x', async () => response(o));
  assert.equal(result.source, raw);
});
await test('exact 256KiB source is accepted without trimming', async () => {
  const base = '{"refetch_done_flag":true,"diff_confirmed_flag":false}';
  const raw = base + ' '.repeat(262144 - Buffer.byteLength(base));
  const observed = await observeFixedKeys('https://synthetic.invalid', 'x', async () => response(fresh(raw)));
  assert.equal(classifyObservation(observed, sha(raw)).result, 'checked');
  assert.equal(classifyObservation(observed, sha(base)).result, 'blocked');
});
await test('streaming response limit counts all chunks and cancels', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  await assert.rejects(observeFixedKeys('https://synthetic.invalid', 'x', async () => new Response(stream)), /M1_PREFLIGHT_RESPONSE_LIMIT/);
  assert.equal(cancelled, true);
});
await test('hung body read is aborted and cancelled within HTTP budget', async () => {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  let expire, cancelled = false;
  globalThis.setTimeout = (fn, ms) => { assert.equal(ms, HTTP_MS); expire = fn; return {}; };
  globalThis.clearTimeout = () => {};
  try {
    const stream = new ReadableStream({ pull() { queueMicrotask(() => expire()); return new Promise(() => {}); }, cancel() { cancelled = true; } });
    await assert.rejects(observeFixedKeys('https://synthetic.invalid', 'x', async () => new Response(stream)), /M1_PREFLIGHT_TIMEOUT/);
    assert.equal(cancelled, true);
  } finally { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; }
});
for (const budget of [HTTP_MS, TOOL_MS]) {
  await test('timeout aborts hung response and never retries', async () => {
    const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
    const timers = new Map(); let calls = 0;
    globalThis.setTimeout = (fn, ms) => { const id = {}; timers.set(ms, { fn, id }); return id; };
    globalThis.clearTimeout = () => {};
    try {
      prepare();
      const promise = main(argv, () => { calls++; queueMicrotask(() => timers.get(budget).fn()); return new Promise(() => {}); });
      await assert.rejects(promise, /M1_PREFLIGHT_TIMEOUT/);
      assert.equal(calls, 1); assert.ok(timers.has(15000)); assert.ok(timers.has(45000));
    } finally { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; }
  });
}
async function capture(execute) {
  const log = console.log, error = console.error; const out = [], err = [];
  console.log = value => out.push(value); console.error = value => err.push(value);
  try { return { code: await runCli([], execute), out, err }; } finally { console.log = log; console.error = error; }
}
for (const bad of [new Error('https://synthetic.invalid SYNTHETIC_PRIVATE_TOKEN PRIVATE_ORDER_SENTINEL'),
  Object.defineProperty({}, 'message', { get() { throw new Error('SECRET'); } }),
  new Proxy({}, { get() { throw new Error('SECRET'); } }), { message: 'M1_PREFLIGHT_TIMEOUT\nSECRET' }]) {
  await test('fixed error boundary', async () => assert.deepEqual(await capture(() => { throw bad; }),
    { code: 1, out: [], err: ['M1_PREFLIGHT_FAILED'] }));
}
for (const mutate of [r => r.extra = 'SECRET', r => r.lease_owner = 'SECRET', r => r.legacy_phase = 'SECRET',
  r => r.source_bytes = Number.MAX_SAFE_INTEGER + 1, r => r.source_bytes = null, r => r.fingerprint_match = 'true',
  r => r.attempt = 'running', r => Object.defineProperty(r, 'source_bytes', { get() { throw 'SECRET'; } })]) {
  await test('reject invalid final output without leakage', async () => {
    const r = classifyObservation(fresh(), fingerprint); mutate(r);
    const v = await capture(() => r); assert.equal(v.code, 1); assert.equal(v.out.length, 0);
    assert.ok(v.err.every(x => /^M1_PREFLIGHT_(OUTPUT|FAILED)$/.test(x)));
  });
}
await test('checked and blocked final output codes', async () => {
  for (const [fp, code] of [[fingerprint, 0], ['0'.repeat(64), 2]]) {
    const r = classifyObservation(fresh(), fp); assert.equal(Object.keys(validateFixedResult(r)).length, 13);
    const v = await capture(() => r); assert.equal(v.code, code); assert.equal(v.err.length, 0);
    for (const secret of ['PRIVATE_ORDER_SENTINEL', 'SYNTHETIC_PRIVATE_TOKEN', 'https://synthetic.invalid', fingerprint])
      assert.ok(!v.out.join('').includes(secret));
  }
});
await test('no implicit SDK/dotenv or session exploration import', () => {
  for (const file of ['check-m1-fixed-preflight.mjs', 'm1-readonly-transport.mjs']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/from ['"](?:dotenv|@upstash\/redis)|import\(['"].*upstash|\bSCAN\b/.test(text));
  }
});
delete process.env.M1_TEST_URL; delete process.env.M1_TEST_TOKEN;
assert.equal(realFetchCalls, 0);
console.log(`M1 fixed preflight: ${count} scenarios passed (fake only / real network 0)`);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { MemoryRedis } from '../lib/memory-redis.ts';
import { encodeWorkflowMset, WORKFLOW_MSET_SCRIPT } from '../lib/redis-like.ts';
import { applyMigration, inspectMigration, RECORD, VERSION } from './migrations/diff-modal-01-v1.ts';
import { main, runCli } from './migrate-diff-modal-01-v1.mjs';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const original = '{ "refetch_done_flag": true, "diff_confirmed_flag": false, "order_results": {"OLD":{"status":"not_in_open_orders","issues":[]}}, "note":"合成\\n\\\"確認" }';
const fp = createHash('sha256').update(original).digest('hex');
async function fixture() {
  const redis = new MemoryRedis();
  await redis.set('orders:refetch_state', original);
  await redis.set('orders:workflow_operation_lease', 'owner');
  await redis.set('order_snapshot_pending:OLD', 'untouched');
  await redis.sadd('index:order_snapshot_pending', 'OLD');
  return redis;
}
let count = 0;
for (const stop of [0, 1, 2, 3]) {
  for (const after of [false, true]) {
    const redis = await fixture();
    const mutate = redis.workflowMset.bind(redis);
    let call = 0;
    redis.workflowMset = async (guards, writes) => {
      const i = call++;
      if (i === stop && !after) throw new Error('simulated loss');
      const result = await mutate(guards, writes);
      if (i === stop && after) throw new Error('simulated loss');
      return result;
    };
    try { await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' }); } catch { /* deterministic interruption */ }
    redis.workflowMset = mutate;
    const result = await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' });
    assert.equal(result.status, 'adopted');
    const record = JSON.parse(await redis.getRawString(RECORD));
    assert.equal(record.source_raw, original);
    assert.equal(record.source_bytes, Buffer.byteLength(original));
    assert.equal(await redis.get('order_snapshot_pending:OLD'), 'untouched');
    assert.deepEqual(await redis.smembers('index:order_snapshot_pending'), ['OLD']);
    await redis.set('orders:refetch_state', 'newer workflow data');
    assert.equal((await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' })).status, 'adopted');
    assert.equal(await redis.get('orders:refetch_state'), 'newer workflow data');
    count++;
  }
}
{
  const redis = await fixture();
  await assert.rejects(applyMigration(redis, { expectedFingerprint: '0'.repeat(64), leaseValue: 'owner' }));
  assert.equal(await redis.getRawString(RECORD), null);
  assert.equal(await redis.getRawString('orders:refetch_state'), original);
  await redis.set('session:current', 'starting-session');
  await assert.rejects(applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' }));
  assert.equal(await redis.getRawString(RECORD), null); count++;
}
{
  const redis = await fixture();
  const raw = JSON.stringify({ refetch_done_flag: true, diff_confirmed_flag: false, extra: '界'.repeat(90000) });
  await redis.set('orders:refetch_state', raw);
  await assert.rejects(applyMigration(redis, { expectedFingerprint: createHash('sha256').update(raw).digest('hex'), leaseValue: 'owner' }));
  assert.equal(await redis.getRawString(RECORD), null);
  assert.equal(await redis.get('orders:refetch_state'), raw); count++;
}
{
  const redis = await fixture();
  await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' });
  const record = JSON.parse(await redis.getRawString(RECORD)); record.source_raw += ' ';
  await redis.set(RECORD, JSON.stringify(record));
  await assert.rejects(inspectMigration(redis), /RECORD_MISMATCH/); count++;
}
{
  const command = encodeWorkflowMset([{ key: 'guard', expected: '旧"\\\n' }], [{ key: 'value', value: '新"\\\n' }]);
  assert.equal(command.bytes, Buffer.byteLength(JSON.stringify([['eval', WORKFLOW_MSET_SCRIPT, command.keys.length, ...command.keys, command.payload]])));
  assert.throws(() => encodeWorkflowMset([], [{ key: 'huge', value: '\\'.repeat(600000) }]), /REQUEST_LIMIT/);
  const redis = new MemoryRedis(); await redis.sadd('wrong-type', 'member');
  await assert.rejects(redis.workflowMset([], [{ key: 'first', value: 'x' }, { key: 'wrong-type', value: 'y' }]));
  assert.equal(await redis.get('first'), null); count++;
}
// Inspect can only call these three bounded reads, never a lease/write operation.
async function readOnlyInspect(redis) {
  const reads = [];
  const allowed = new Map([
    ['orders:workflow_epoch', 4096], [RECORD, 512 * 1024], ['orders:refetch_state', 256 * 1024],
  ]);
  const result = await inspectMigration(new Proxy({}, { get(_target, name) {
    assert.equal(name, 'getRawString', 'inspect must not call any writer');
    return async (key, limit) => {
      assert.equal(limit, allowed.get(key)); reads.push(key);
      return redis.getRawString(key, limit);
    };
  } }));
  assert.deepEqual(reads, [...allowed.keys()].slice(0, result.status === 'adopted' ? 2 : 3));
  return result;
}

async function capture(execute, args = ['inspect']) {
  const out = [], err = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...values) => out.push(values.join(' '));
  console.error = (...values) => err.push(values.join(' '));
  console.warn = (...values) => err.push(values.join(' '));
  try { return { code: await runCli(args, execute), out, err }; }
  finally { Object.assign(console, saved); }
}
const sha = raw => createHash('sha256').update(raw).digest('hex');
const validResults = [];
let validRecord;
for (const status of ['legacy', 'preserved', 'prepared', 'adopted']) {
  const redis = await fixture();
  if (status !== 'legacy') {
    const mutate = redis.workflowMset.bind(redis);
    let writes = 0;
    redis.workflowMset = async (...args) => {
      if (++writes === (status === 'preserved' ? 2 : status === 'prepared' ? 3 : 99)) throw new Error('fixture stop');
      return mutate(...args);
    };
    try { await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' }); }
    catch (error) { assert.equal(error.message, 'fixture stop'); }
    redis.workflowMset = mutate;
    validRecord = JSON.parse(await redis.getRawString(RECORD));
  }
  const result = await readOnlyInspect(redis);
  assert.equal(result.status, status); validResults.push(result);
  const output = await capture(() => readOnlyInspect(redis));
  assert.equal(output.code, 0); assert.deepEqual(output.err, []);
  assert.deepEqual(JSON.parse(output.out[0]), result);
  // Every accepted state retains the existing apply/resend contract.
  assert.equal((await applyMigration(redis, { expectedFingerprint: fp, leaseValue: 'owner' })).status, 'adopted');
  count++;
}

for (const raw of ['{PRIVATE_RAW_SENTINEL', 'null', '[]', 'true', '7', '"PRIVATE_RAW_SENTINEL"', '{}',
  '{"refetch_done_flag":true}', '{"diff_confirmed_flag":false}',
  '{"refetch_done_flag":"PRIVATE_RAW_SENTINEL","diff_confirmed_flag":false}',
  '{"refetch_done_flag":true,"diff_confirmed_flag":0}']) {
  const redis = await fixture(); await redis.set('orders:refetch_state', raw);
  redis.workflowMset = async () => assert.fail('invalid source must not write');
  await assert.rejects(applyMigration(redis, { expectedFingerprint: sha(raw), leaseValue: 'owner' }),
    { message: 'M1_MIGRATION_SOURCE_SCHEMA' });
  assert.deepEqual(await capture(() => readOnlyInspect(redis)),
    { code: 1, out: [], err: ['M1_MIGRATION_SOURCE_SCHEMA'] }); count++;
}

const badFields = [
  ['migration_id', {}], ['migration_id', 1], ['migration_id', null],
  ['migration_id', 'PRIVATE_RAW_SENTINEL'.repeat(2000)], ['migration_id', validRecord.migration_id + '\n'],
  ['migration_id', validRecord.migration_id.replace('-4', '-1')],
  ['epoch', null], ['epoch', 'x\n'], ['epoch', 'x'.repeat(129)],
  ['source_bytes', -1], ['source_bytes', 1.5], ['source_bytes', '1'], ['source_bytes', Number.MAX_SAFE_INTEGER + 1],
  ['source_bytes', 256 * 1024 + 1], ['source_bytes', 0],
  ['source_fingerprint', 'A'.repeat(64)], ['source_fingerprint', '0'.repeat(63)],
  ['source_fingerprint', {}], ['initial_fingerprint', '0'.repeat(64) + '\n'],
  ['initial_fingerprint', 'g'.repeat(64)], ['prepared_at', 'not a date'], ['prepared_at', null],
  ['prepared_at', '2026-02-30T00:00:00.000Z'], ['prepared_at', validRecord.prepared_at + '\n'],
  ['source_raw', original + ' '], ['initial_raw', validRecord.initial_raw + ' '], ['initial_raw', {}],
];
for (const [key, value] of badFields) {
  const redis = await fixture(); await redis.set(RECORD, JSON.stringify({ ...validRecord, [key]: value }));
  assert.deepEqual(await capture(() => readOnlyInspect(redis)),
    { code: 1, out: [], err: ['M1_MIGRATION_RECORD_MISMATCH'] }); count++;
}
for (const recordRaw of ['', 'null', '[]', '{PRIVATE_RAW_SENTINEL']) {
  const redis = await fixture(); await redis.set(RECORD, recordRaw);
  assert.deepEqual(await capture(() => readOnlyInspect(redis)),
    { code: 1, out: [], err: ['M1_MIGRATION_RECORD_MISMATCH'] }); count++;
}
for (const adoptedRaw of ['', 'null', '[]', '{PRIVATE_RAW_SENTINEL']) {
  const redis = await fixture(); await redis.set('orders:workflow_epoch', adoptedRaw);
  assert.deepEqual(await capture(() => readOnlyInspect(redis)),
    { code: 1, out: [], err: ['M1_MIGRATION_ADOPTION_MISMATCH'] }); count++;
}
for (const [key, raw] of [['source_raw', '{"refetch_done_flag":false}'], ['initial_raw', 'null']]) {
  const redis = await fixture();
  const record = { ...validRecord, [key]: raw };
  if (key === 'source_raw') { record.source_bytes = Buffer.byteLength(raw); record.source_fingerprint = sha(raw); }
  else record.initial_fingerprint = sha(raw);
  await redis.set(RECORD, JSON.stringify(record));
  assert.deepEqual(await capture(() => readOnlyInspect(redis)), { code: 1, out: [],
    err: [key === 'source_raw' ? 'M1_MIGRATION_SOURCE_SCHEMA' : 'M1_MIGRATION_RECORD_MISMATCH'] }); count++;
}

// Preserve permissive legacy fields and both boolean values; no new workflow schema.
for (const refetch of [false, true]) for (const confirmed of [false, true]) {
  const redis = await fixture();
  const raw = JSON.stringify({ refetch_done_flag: refetch, diff_confirmed_flag: confirmed, legacy_extra: ['anything'] });
  await redis.set('orders:refetch_state', raw);
  assert.equal((await readOnlyInspect(redis)).status, 'legacy');
  assert.equal((await applyMigration(redis, { expectedFingerprint: sha(raw), leaseValue: 'owner' })).status, 'adopted');
  count++;
}

const success = validResults[0];
const badOutputs = [null, [], 'PRIVATE_RAW_SENTINEL',
  { ...success, extra: 'PRIVATE_RAW_SENTINEL' }, { ...success, status: 'unknown' },
  { ...success, status: {} }, { ...success, version: VERSION + '\n' },
  { ...success, source_bytes: NaN }, { ...success, source_bytes: Infinity },
  { ...success, source_bytes: -1 }, { ...success, source_bytes: 0.5 },
  { ...success, source_bytes: 256 * 1024 + 1 }, { ...success, source_bytes: '1' },
  { ...success, source_fingerprint: fp + '\n' }, { ...success, source_fingerprint: 'F'.repeat(64) },
  { ...success, migration_id: 'PRIVATE_RAW_SENTINEL' }, { ...success, migration_id: {} },
  { ...validResults[1], migration_id: null }, { ...validResults[1], migration_id: 'x'.repeat(9999) },
  { ...validResults[1], migration_id: validRecord.migration_id + '\n' },
  { ...success, toJSON() { throw new Error('PRIVATE_RAW_SENTINEL'); } },
];
const missing = { ...success }; delete missing.source_bytes; badOutputs.push(missing);
const accessor = { ...success };
Object.defineProperty(accessor, 'migration_id', { get() { throw new Error('PRIVATE_RAW_SENTINEL'); } });
badOutputs.push(accessor);
for (const output of badOutputs) {
  assert.deepEqual(await capture(async () => output), { code: 1, out: [], err: ['M1_CLI_OUTPUT_INVALID'] }); count++;
}
for (const message of ['PRIVATE_RAW_SENTINEL https://fixture.invalid token=FAKE', 'M1_PRIVATE_RAW_SENTINEL']) {
  assert.deepEqual(await capture(async () => { throw new Error(message); }),
    { code: 1, out: [], err: ['M1_MIGRATION_FAILED'] }); count++;
}

// Run the actual CLI main/adapter through fake fetch, with no credential fallback or dotenv reads.
let dotenvReads = 0;
const savedReads = { sync: fs.readFileSync, callback: fs.readFile, promise: fsPromises.readFile };
const checkPath = value => {
  if (/(^|[/\\])\.env(?:[^/\\]*)$/.test(String(value))) { dotenvReads++; throw new Error('DOTENV_FORBIDDEN'); }
};
fs.readFileSync = function(file, ...args) { checkPath(file); return savedReads.sync.call(this, file, ...args); };
fs.readFile = function(file, ...args) { checkPath(file); return savedReads.callback.call(this, file, ...args); };
fsPromises.readFile = function(file, ...args) { checkPath(file); return savedReads.promise.call(this, file, ...args); };
syncBuiltinESMExports();
process.env.M1_TEST_ONLY_TOKEN = 'synthetic-not-a-real-token';
const requests = [];
const cliArgs = ['inspect', '--url', 'https://m1-fixture.invalid', '--token-env', 'M1_TEST_ONLY_TOKEN'];
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://m1-fixture.invalid');
    const command = JSON.parse(options.body); requests.push(command);
    assert.equal(command[0], 'eval'); assert.equal(command[2], 1);
    assert.equal(command[1].match(/redis\.call/g)?.length, 1);
    assert.ok(command[1].includes("redis.call('GET',KEYS[1])"));
    assert.ok(['orders:workflow_epoch', RECORD, 'orders:refetch_state'].includes(command[3]));
    const raw = command[3] === 'orders:refetch_state' ? original : null;
    return new Response(JSON.stringify({ result: raw === null ? null : Buffer.from('RAW:' + raw).toString('base64') }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  assert.deepEqual(await capture(main, cliArgs), { code: 0, out: [JSON.stringify(success)], err: [] });
  assert.equal(requests.length, 3); count++;
  requests.length = 0;
  assert.deepEqual(await capture(main, ['inspect']),
    { code: 1, out: [], err: ['M1_CLI_EXPLICIT_TARGET_REQUIRED'] });
  assert.equal(requests.length, 0); count++;
  let failures = 0;
  globalThis.fetch = async () => { failures++; throw new Error('PRIVATE_RAW_SENTINEL https://fixture.invalid token=FAKE'); };
  assert.deepEqual(await capture(main, cliArgs), { code: 1, out: [], err: ['M1_MIGRATION_FAILED'] });
  assert.equal(failures, 1, 'no automatic retry'); count++;
  assert.equal(dotenvReads, 0);
} finally {
  fs.readFileSync = savedReads.sync; fs.readFile = savedReads.callback; fsPromises.readFile = savedReads.promise;
  syncBuiltinESMExports(); delete process.env.M1_TEST_ONLY_TOKEN;
  globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
}
{
  const { UpstashRedisAdapter } = await import('../lib/upstash.ts');
  let command;
  const pipeline = { eval(script, keys, args) { command = [script, keys, args]; return this; }, async exec() { return [1]; } };
  const adapter = new UpstashRedisAdapter({ pipeline: () => pipeline, eval: async () => 'RAW:' + original });
  assert.equal(await adapter.getRawString('source'), original);
  assert.equal(await adapter.workflowMset([{ key: 'lease', expected: 'owner' }], [{ key: 'target', value: '合成' }]), true);
  assert.equal(command[0], WORKFLOW_MSET_SCRIPT);
  assert.deepEqual(command[1], ['lease', 'target']);
  assert.equal(command[2].length, 1); count++;
}
console.log('M1 migration / inspect / stdout contract: ' + count + ' scenarios passed (no network)');

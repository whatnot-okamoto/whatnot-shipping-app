import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryRedis } from '../lib/memory-redis.ts';
import { encodeWorkflowMset, WORKFLOW_MSET_SCRIPT } from '../lib/redis-like.ts';
import { applyMigration, inspectMigration, RECORD } from './migrations/diff-modal-01-v1.ts';

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
{
  process.env.APP_ENVIRONMENT = 'local'; process.env.BASE_DATA_MODE = 'mock'; process.env.APP_STORE_MODE = 'memory';
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
console.log('M1 migration / atomic contract: ' + count + ' scenarios passed (no network)');

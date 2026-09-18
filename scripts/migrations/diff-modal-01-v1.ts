import { createHash, randomUUID } from 'node:crypto';
import { encodeWorkflowMset, type RedisLike } from '../../lib/redis-like';

export const VERSION = 'diff-modal-01:v1';
export const RECORD = 'orders:migration:diff-modal-01:v1';
const STATE = 'orders:refetch_state';
const EPOCH = 'orders:workflow_epoch';
const LEASE = 'orders:workflow_operation_lease';
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
type RecordV1 = {
  schema_version: 1; migration_version: typeof VERSION; migration_id: string;
  source_raw: string; source_bytes: number; source_fingerprint: string;
  epoch: string; initial_raw: string; initial_fingerprint: string; prepared_at: string;
};
function validRecord(raw: string): RecordV1 {
  const r = JSON.parse(raw) as RecordV1;
  if (r.schema_version !== 1 || r.migration_version !== VERSION || typeof r.source_raw !== 'string' ||
      Buffer.byteLength(r.source_raw) !== r.source_bytes || r.source_bytes > 256 * 1024 ||
      sha(r.source_raw) !== r.source_fingerprint || sha(r.initial_raw) !== r.initial_fingerprint ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(r.epoch) || !r.migration_id)
    throw new Error('M1_MIGRATION_RECORD_MISMATCH');
  const initial = JSON.parse(r.initial_raw);
  if (initial.schema_version !== 1 || initial.workflow_epoch !== r.epoch || initial.phase !== 'requires_refetch' ||
      initial.refetch_done_flag !== false || initial.diff_confirmed_flag !== false || initial.publication_revision !== 0)
    throw new Error('M1_MIGRATION_RECORD_MISMATCH');
  return r;
}
const adoptionValue = (r: RecordV1, adoptedAt = new Date().toISOString()) => JSON.stringify({ schema_version: 1, workflow_epoch: r.epoch,
  adoption_status: 'adopted', migration_version: VERSION, migration_id: r.migration_id,
  source_fingerprint: r.source_fingerprint, adopted_at: adoptedAt });

/** Explicit store only: no global client, environment lookup, BASE call or raw logging. */
export async function inspectMigration(store: RedisLike) {
  const adoptedRaw = await store.getRawString(EPOCH, 4096);
  const recordRaw = await store.getRawString(RECORD, 512 * 1024);
  const record = recordRaw ? validRecord(recordRaw) : null;
  if (adoptedRaw) {
    const adopted = JSON.parse(adoptedRaw);
    if (!record || typeof adopted.adopted_at !== 'string' || !Number.isFinite(Date.parse(adopted.adopted_at)) ||
        adoptedRaw !== adoptionValue(record, adopted.adopted_at)) throw new Error('M1_MIGRATION_ADOPTION_MISMATCH');
    return { status: 'adopted' as const, version: VERSION, source_bytes: record.source_bytes,
      source_fingerprint: record.source_fingerprint, migration_id: record.migration_id };
  }
  const source = await store.getRawString(STATE, 256 * 1024);
  if (source === null) throw new Error('M1_MIGRATION_SOURCE_MISSING');
  if (record && source !== record.source_raw && source !== record.initial_raw)
    throw new Error('M1_MIGRATION_SOURCE_CHANGED');
  return { status: record ? source === record.initial_raw ? 'prepared' as const : 'preserved' as const : 'legacy' as const,
    version: VERSION, source_bytes: record?.source_bytes ?? Buffer.byteLength(source),
    source_fingerprint: record?.source_fingerprint ?? sha(source), migration_id: record?.migration_id ?? null };
}

export async function applyMigration(store: RedisLike, options: { expectedFingerprint: string; leaseValue: string }) {
  const status = await inspectMigration(store);
  if (status.source_fingerprint !== options.expectedFingerprint) throw new Error('M1_MIGRATION_SOURCE_CHANGED');
  if (status.status === 'adopted') return status;
  const guards = [
    { key: LEASE, expected: options.leaseValue }, { key: EPOCH, expected: null },
    { key: 'session:current', expected: null }, { key: 'orders:refetch_attempt', expected: null },
  ];
  let recordRaw = await store.getRawString(RECORD, 512 * 1024);
  if (!recordRaw) {
    const source = await store.getRawString(STATE, 256 * 1024);
    if (source === null || sha(source) !== options.expectedFingerprint) throw new Error('M1_MIGRATION_SOURCE_CHANGED');
    const old = JSON.parse(source);
    if (typeof old.refetch_done_flag !== 'boolean' || typeof old.diff_confirmed_flag !== 'boolean')
      throw new Error('M1_MIGRATION_SOURCE_SCHEMA');
    const epoch = randomUUID();
    const initialRaw = JSON.stringify({ schema_version: 1, workflow_epoch: epoch, publication_revision: 0,
      phase: 'requires_refetch', refetch_done_flag: false, diff_confirmed_flag: false,
      refetched_at: null, has_new_uninitialized: false, order_results: {}, confirmation_manifest: {},
      initialization_keys: [], held_bundle_order_keys: [] });
    const record: RecordV1 = { schema_version: 1, migration_version: VERSION, migration_id: randomUUID(),
      source_raw: source, source_bytes: Buffer.byteLength(source), source_fingerprint: sha(source),
      epoch, initial_raw: initialRaw, initial_fingerprint: sha(initialRaw), prepared_at: new Date().toISOString() };
    recordRaw = JSON.stringify(record);
    if (Buffer.byteLength(recordRaw) > 512 * 1024) throw new Error('M1_MIGRATION_RECORD_LIMIT');
    // Preflight ALL request bodies before the first write, including escaping.
    encodeWorkflowMset([...guards, { key: STATE, expected: source }, { key: RECORD, expected: null }],
      [{ key: RECORD, value: recordRaw }]);
    encodeWorkflowMset([...guards, { key: RECORD, expected: recordRaw }, { key: STATE, expected: source }],
      [{ key: STATE, value: initialRaw }]);
    encodeWorkflowMset([...guards, { key: RECORD, expected: recordRaw }, { key: STATE, expected: initialRaw }],
      [{ key: EPOCH, value: adoptionValue(record) }]);
    if (!await store.workflowMset([...guards, { key: STATE, expected: source }, { key: RECORD, expected: null }],
      [{ key: RECORD, value: recordRaw }])) throw new Error('M1_MIGRATION_CONFLICT');
  }
  const record = validRecord(recordRaw);
  if (record.source_fingerprint !== options.expectedFingerprint) throw new Error('M1_MIGRATION_RECORD_MISMATCH');
  const current = await store.getRawString(STATE, 256 * 1024);
  if (current === record.source_raw) {
    if (!await store.workflowMset([...guards, { key: RECORD, expected: recordRaw }, { key: STATE, expected: current }],
      [{ key: STATE, value: record.initial_raw }])) throw new Error('M1_MIGRATION_CONFLICT');
  } else if (current !== record.initial_raw) throw new Error('M1_MIGRATION_SOURCE_CHANGED');
  if (!await store.workflowMset([...guards, { key: RECORD, expected: recordRaw }, { key: STATE, expected: record.initial_raw }],
    [{ key: EPOCH, value: adoptionValue(record) }])) throw new Error('M1_MIGRATION_CONFLICT');
  return inspectMigration(store);
}

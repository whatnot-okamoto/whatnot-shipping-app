import { createHash, randomUUID } from 'node:crypto';
import { encodeWorkflowMset, type RedisLike } from '../../lib/redis-like';
import { validateLegacySource } from '../../lib/m1-legacy-source';
export { validateLegacySource } from '../../lib/m1-legacy-source';

export const VERSION = 'diff-modal-01:v1';
export const RECORD = 'orders:migration:diff-modal-01:v1';
const STATE = 'orders:refetch_state';
const EPOCH = 'orders:workflow_epoch';
const LEASE = 'orders:workflow_operation_lease';
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
const SOURCE_LIMIT = 256 * 1024;
const isSha = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const isBytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= SOURCE_LIMIT;
const isDate = (value: unknown): value is string => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function parseObject(raw: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Never expose parser diagnostics or source contents. */ }
  throw new Error(code);
}

/** Final stdout boundary: validate exact own data properties, then reconstruct scalars. */
export function validateMigrationResult(value: unknown) {
  const fail = () => { throw new Error('M1_CLI_OUTPUT_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const fields = ['status', 'version', 'source_bytes', 'source_fingerprint', 'migration_id'];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) return fail();
  const r = value as Record<string, unknown>;
  if (!['legacy', 'preserved', 'prepared', 'adopted'].includes(r.status as string) || r.version !== VERSION ||
      !isBytes(r.source_bytes) || !isSha(r.source_fingerprint) ||
      (r.status === 'legacy' ? r.migration_id !== null : !isUuid(r.migration_id))) return fail();
  return { status: r.status, version: VERSION, source_bytes: r.source_bytes,
    source_fingerprint: r.source_fingerprint, migration_id: r.migration_id };
}
type RecordV1 = {
  schema_version: 1; migration_version: typeof VERSION; migration_id: string;
  source_raw: string; source_bytes: number; source_fingerprint: string;
  epoch: string; initial_raw: string; initial_fingerprint: string; prepared_at: string;
};
function validRecord(raw: string): RecordV1 {
  const r = parseObject(raw, 'M1_MIGRATION_RECORD_MISMATCH');
  if (r.schema_version !== 1 || r.migration_version !== VERSION || typeof r.source_raw !== 'string' ||
      typeof r.initial_raw !== 'string' || Buffer.byteLength(r.initial_raw) > SOURCE_LIMIT ||
      !isBytes(r.source_bytes) || Buffer.byteLength(r.source_raw) !== r.source_bytes ||
      !isSha(r.source_fingerprint) || !isSha(r.initial_fingerprint) ||
      sha(r.source_raw) !== r.source_fingerprint || sha(r.initial_raw) !== r.initial_fingerprint ||
      typeof r.epoch !== 'string' || r.epoch.length < 1 || r.epoch.length > 128 || /[^A-Za-z0-9_-]/.test(r.epoch) ||
      !isUuid(r.migration_id) || !isDate(r.prepared_at))
    throw new Error('M1_MIGRATION_RECORD_MISMATCH');
  validateLegacySource(r.source_raw);
  const initial = parseObject(r.initial_raw, 'M1_MIGRATION_RECORD_MISMATCH');
  if (initial.schema_version !== 1 || initial.workflow_epoch !== r.epoch || initial.phase !== 'requires_refetch' ||
      initial.refetch_done_flag !== false || initial.diff_confirmed_flag !== false || initial.publication_revision !== 0)
    throw new Error('M1_MIGRATION_RECORD_MISMATCH');
  return r as RecordV1;
}
const adoptionValue = (r: RecordV1, adoptedAt = new Date().toISOString()) => JSON.stringify({ schema_version: 1, workflow_epoch: r.epoch,
  adoption_status: 'adopted', migration_version: VERSION, migration_id: r.migration_id,
  source_fingerprint: r.source_fingerprint, adopted_at: adoptedAt });

/** Explicit store only: no global client, environment lookup, BASE call or raw logging. */
export async function inspectMigration(store: RedisLike) {
  const adoptedRaw = await store.getRawString(EPOCH, 4096);
  const recordRaw = await store.getRawString(RECORD, 512 * 1024);
  const record = recordRaw !== null ? validRecord(recordRaw) : null;
  if (adoptedRaw !== null) {
    const adopted = parseObject(adoptedRaw, 'M1_MIGRATION_ADOPTION_MISMATCH');
    if (!record || typeof adopted.adopted_at !== 'string' || !Number.isFinite(Date.parse(adopted.adopted_at)) ||
        adoptedRaw !== adoptionValue(record, adopted.adopted_at)) throw new Error('M1_MIGRATION_ADOPTION_MISMATCH');
    return { status: 'adopted' as const, version: VERSION, source_bytes: record.source_bytes,
      source_fingerprint: record.source_fingerprint, migration_id: record.migration_id };
  }
  const source = await store.getRawString(STATE, 256 * 1024);
  if (source === null) throw new Error('M1_MIGRATION_SOURCE_MISSING');
  if (record && source !== record.source_raw && source !== record.initial_raw)
    throw new Error('M1_MIGRATION_SOURCE_CHANGED');
  if (!record) validateLegacySource(source);
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
  if (recordRaw === null) {
    const source = await store.getRawString(STATE, 256 * 1024);
    if (source === null || sha(source) !== options.expectedFingerprint) throw new Error('M1_MIGRATION_SOURCE_CHANGED');
    validateLegacySource(source);
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

// Local operator tool; actual execution requires a separate one-time approval.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateLegacySource } from './migrations/diff-modal-01-v1.ts';
import { observeFixedKeys } from './m1-readonly-transport.mjs';

export const TOOL_VERSION = 'm1-fixed-preflight:v1';
export const TOOL_MS = 45_000;
const SOURCE_LIMIT = 262144;
const fingerprintValid = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const presence = type => type === 'none' ? 'absent' : type === 'string' ? 'unexpected_present' : 'invalid_type';
const phases = ['requires_refetch', 'awaiting_initialization', 'awaiting_review', 'promoting', 'postprocessing', 'confirmed'];
const errors = new Set(['M1_PREFLIGHT_ARGUMENT', 'M1_PREFLIGHT_TARGET', 'M1_PREFLIGHT_CREDENTIAL',
  'M1_PREFLIGHT_RESPONSE', 'M1_PREFLIGHT_RESPONSE_LIMIT', 'M1_PREFLIGHT_REQUEST_LIMIT',
  'M1_PREFLIGHT_TIMEOUT', 'M1_PREFLIGHT_HTTP', 'M1_PREFLIGHT_OUTPUT']);
function exactObject(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some(k => !fields.includes(k)) ||
      fields.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) ?? {}, 'value'))) throw new Error(code);
}
export function classifyObservation(observation, expectedFingerprint) {
  if (!fingerprintValid(expectedFingerprint)) throw new Error('M1_PREFLIGHT_ARGUMENT');
  exactObject(observation, ['types', 'lengths', 'ttl', 'source'], 'M1_PREFLIGHT_RESPONSE');
  const { types: t, lengths: n, ttl, source: raw } = observation;
  const redisTypes = ['none', 'string', 'list', 'set', 'zset', 'hash', 'stream'];
  if (!Array.isArray(t) || t.length !== 6 || t.some(v => !redisTypes.includes(v)) ||
      !Array.isArray(n) || n.length !== 6 || n.some((v, i) => i < 2 || t[i] !== 'string' ? v !== null :
        !Number.isSafeInteger(v) || v < 0) || !Number.isSafeInteger(ttl) || ttl < -2)
    throw new Error('M1_PREFLIGHT_RESPONSE');
  const canRead = [0, 1, 3, 4, 5].every(i => t[i] === 'none') && ttl === -2 && t[2] === 'string' && n[2] <= SOURCE_LIMIT;
  if (canRead ? typeof raw !== 'string' || Buffer.byteLength(raw) !== n[2] : raw !== null)
    throw new Error('M1_PREFLIGHT_RESPONSE');
  const r = { tool_version: TOOL_VERSION, result: 'blocked', epoch: presence(t[0]), migration_record: presence(t[1]),
    source: 'not_read', source_bytes: n[2], fingerprint_match: null, session_current: presence(t[3]),
    lease: presence(t[4]), lease_ttl: 'indeterminate', attempt: presence(t[5]),
    legacy_phase: 'not_read', legacy_unfinished: null };
  if (t[4] === 'none' && ttl === -2) r.lease_ttl = 'absent';
  else if (t[4] !== 'none' && ttl > 0) r.lease_ttl = 'positive';
  else if (t[4] !== 'none' && ttl === -1) r.lease_ttl = 'no_expiry';
  if (t[2] === 'none') r.source = 'missing';
  else if (t[2] !== 'string') r.source = 'invalid_type';
  else if (n[2] > SOURCE_LIMIT) r.source = 'too_large';
  if (r.lease_ttl === 'indeterminate') r.result = 'indeterminate';
  if (canRead) {
    try { validateLegacySource(raw); } catch { r.source = 'invalid_schema'; return validateFixedResult(r); }
    r.source = 'valid';
    r.fingerprint_match = createHash('sha256').update(raw, 'utf8').digest('hex') === expectedFingerprint;
    const state = JSON.parse(raw);
    r.legacy_phase = !Object.hasOwn(state, 'phase') ? 'missing' : typeof state.phase !== 'string' ? 'invalid' :
      phases.includes(state.phase) ? state.phase : 'unknown';
    if (phases.includes(r.legacy_phase)) r.legacy_unfinished = r.legacy_phase !== 'confirmed' ||
      !state.refetch_done_flag || !state.diff_confirmed_flag;
    r.result = ['unknown', 'invalid'].includes(r.legacy_phase) ? 'indeterminate' :
      !r.fingerprint_match ? 'blocked' : 'checked';
  }
  return validateFixedResult(r);
}
const enumFields = Object.freeze({
  tool_version: [TOOL_VERSION], result: ['checked', 'blocked', 'indeterminate'],
  epoch: ['absent', 'unexpected_present', 'invalid_type'], migration_record: ['absent', 'unexpected_present', 'invalid_type'],
  source: ['not_read', 'valid', 'missing', 'invalid_type', 'too_large', 'invalid_schema'],
  session_current: ['absent', 'unexpected_present', 'invalid_type'], lease: ['absent', 'unexpected_present', 'invalid_type'],
  lease_ttl: ['absent', 'positive', 'no_expiry', 'indeterminate'], attempt: ['absent', 'unexpected_present', 'invalid_type'],
  legacy_phase: [...phases, 'not_read', 'missing', 'unknown', 'invalid'],
});
export function validateFixedResult(value) {
  const fields = [...Object.keys(enumFields), 'source_bytes', 'fingerprint_match', 'legacy_unfinished'];
  exactObject(value, fields, 'M1_PREFLIGHT_OUTPUT');
  for (const [key, values] of Object.entries(enumFields)) if (!values.includes(value[key])) throw new Error('M1_PREFLIGHT_OUTPUT');
  if (!(value.source_bytes === null || Number.isSafeInteger(value.source_bytes) && value.source_bytes >= 0) ||
      ![true, false, null].includes(value.fingerprint_match) || ![true, false, null].includes(value.legacy_unfinished))
    throw new Error('M1_PREFLIGHT_OUTPUT');
  if (value.result === 'checked' && (['epoch', 'migration_record', 'session_current', 'lease', 'attempt'].some(k => value[k] !== 'absent') ||
      value.lease_ttl !== 'absent' || value.source !== 'valid' || value.fingerprint_match !== true ||
      value.source_bytes === null || value.source_bytes > SOURCE_LIMIT || ['not_read', 'unknown', 'invalid'].includes(value.legacy_phase))) throw new Error('M1_PREFLIGHT_OUTPUT');
  return Object.fromEntries(fields.map(k => [k, value[k]]));
}
export async function main(argv = process.argv.slice(2), fetchImpl = globalThis.fetch) {
  if (argv.length !== 6) throw new Error('M1_PREFLIGHT_ARGUMENT');
  const o = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--url-env', '--token-env', '--expected-fingerprint'].includes(argv[i]) || o.has(argv[i])) throw new Error('M1_PREFLIGHT_ARGUMENT');
    o.set(argv[i], argv[i + 1]);
  }
  const urlName = o.get('--url-env'), tokenName = o.get('--token-env'), expected = o.get('--expected-fingerprint');
  const nameValid = v => typeof v === 'string' && v.length <= 128 && /^[A-Z][A-Z0-9_]*$/.test(v) && v.trim() === v;
  if (!nameValid(urlName) || !nameValid(tokenName) || urlName === tokenName || !fingerprintValid(expected)) throw new Error('M1_PREFLIGHT_ARGUMENT');
  let endpoint, token, observation;
  try { endpoint = process.env[urlName]; token = process.env[tokenName]; }
  finally { delete process.env[urlName]; delete process.env[tokenName]; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_MS);
  try {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('M1_PREFLIGHT_TARGET'); }
    if (typeof endpoint !== 'string' || endpoint.length > 4096 || /[\x00-\x20\x7f]/.test(endpoint) ||
        url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('M1_PREFLIGHT_TARGET');
    if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n\x00]/.test(token)) throw new Error('M1_PREFLIGHT_CREDENTIAL');
    observation = await observeFixedKeys(endpoint, token, fetchImpl, controller.signal);
    const result = classifyObservation(observation, expected);
    if (controller.signal.aborted) throw new Error('M1_PREFLIGHT_TIMEOUT');
    return result;
  } finally {
    clearTimeout(timer); controller.abort();
    if (observation) observation.source = null;
    observation = null; endpoint = null; token = null;
  }
}
export async function runCli(argv = process.argv.slice(2), execute = main) {
  try {
    const safe = validateFixedResult(await execute(argv));
    const output = JSON.stringify(safe);
    if (output.length > 4096) throw new Error('M1_PREFLIGHT_OUTPUT');
    console.log(output);
    return safe.result === 'checked' ? 0 : 2;
  } catch (error) {
    let code = 'M1_PREFLIGHT_FAILED';
    try { const message = error?.message; if (typeof message === 'string' && errors.has(message)) code = message; } catch { }
    console.error(code);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli();

import { createHash, randomBytes } from 'node:crypto';
import { validateLegacySource } from './m1-legacy-source';
import type { RedisLike } from './redis-like';

export const EXPECTED_FINGERPRINT = 'b526ecdc779f62dcabafa270b20070843882fe4c44df089187b8826a6262106b';
export const SOURCE_LIMIT = 256 * 1024;
export const RUN_MS = 120_000;
const SOURCE = 'orders:refetch_state';
const PRESENCE = [
  ['epoch', 'orders:workflow_epoch'], ['migration_record', 'orders:migration:diff-modal-01:v1'],
  ['session', 'session:current'], ['lease', 'orders:workflow_operation_lease'], ['attempt', 'orders:refetch_attempt'],
] as const;
const PHASES = ['requires_refetch', 'awaiting_initialization', 'awaiting_review', 'promoting', 'postprocessing', 'confirmed'] as const;
const ENUMS = {
  version: ['m1-production-preflight:v1'], result: ['checked', 'blocked', 'indeterminate'],
  reason: ['none', 'unavailable', 'unauthorized', 'input', 'method', 'present', 'source', 'phase', 'fingerprint', 'changed', 'read_failed', 'timeout'],
  epoch: ['not_read', 'absent', 'present'], migration_record: ['not_read', 'absent', 'present'],
  session: ['not_read', 'absent', 'present'], lease: ['not_read', 'absent', 'present'], attempt: ['not_read', 'absent', 'present'],
  phase: [...PHASES, 'not_read', 'missing', 'unknown', 'invalid'],
} as const;
type Result = {
  -readonly [K in keyof typeof ENUMS]: (typeof ENUMS)[K][number];
} & { source_bytes: number | null; fingerprint_match: boolean | null; before_after_match: boolean | null; logical_reads: number };
const initial = (): Result => ({ version: 'm1-production-preflight:v1', result: 'blocked', reason: 'none',
  epoch: 'not_read', migration_record: 'not_read', session: 'not_read', lease: 'not_read', attempt: 'not_read',
  phase: 'not_read', source_bytes: null, fingerprint_match: null, before_after_match: null, logical_reads: 0 });
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

// Shared by server output and the self-contained page. No arbitrary fields are rendered.
export function safeResult(value: unknown): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const r = value as Record<string, unknown>;
    const fields = [...Object.keys(ENUMS), 'source_bytes', 'fingerprint_match', 'before_after_match', 'logical_reads'];
    if (Reflect.ownKeys(r).length !== fields.length || fields.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(r, k) ?? {}, 'value'))) return false;
    for (const [key, allowed] of Object.entries(ENUMS)) if (!(allowed as readonly unknown[]).includes(r[key])) return false;
    if (r.result === 'checked' && (r.reason !== 'none' || r.fingerprint_match !== true || r.before_after_match !== true ||
        r.logical_reads !== 12 || r.source_bytes === null || ['not_read', 'unknown', 'invalid'].includes(String(r.phase)) ||
        ['epoch', 'migration_record', 'session', 'lease', 'attempt'].some(k => r[k] !== 'absent'))) return false;
    return (r.source_bytes === null || Number.isSafeInteger(r.source_bytes) && Number(r.source_bytes) >= 0 && Number(r.source_bytes) <= SOURCE_LIMIT) &&
      [null, true, false].includes(r.fingerprint_match as null | boolean) && [null, true, false].includes(r.before_after_match as null | boolean) &&
      Number.isSafeInteger(r.logical_reads) && Number(r.logical_reads) >= 0 && Number(r.logical_reads) <= 12;
  } catch { return false; }
}
function reply(r: Result, status: number): Response {
  if (!safeResult(r)) return new Response('M1_MAINTENANCE_FAILED', { status: 500, headers: headers() });
  return Response.json(r, { status, headers: headers() });
}
function headers(): Record<string, string> {
  return { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
}
export function maintenanceWindow(value: string | undefined, now: number): boolean {
  if (typeof value !== 'string' || !Number.isFinite(now)) return false;
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some(v => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))) return false;
  const [start, end] = parts.map(Date.parse);
  return Number.isFinite(start) && Number.isFinite(end) && parts[0] === new Date(start).toISOString() &&
    parts[1] === new Date(end).toISOString() && end > start && end - start <= 30 * 60_000 && now >= start && now < end;
}
type Dependencies = {
  expectedFingerprint: string;
  requireAuth: (request: Request) => Promise<Response | null>;
  production: () => boolean;
  window: () => string | undefined;
  origin: () => string | undefined;
  reader: (signal: AbortSignal) => Promise<Pick<RedisLike, 'exists' | 'getRawString'>>;
  now?: () => number;
};
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('STOP');
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new Error('STOP'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export function createProductionPreflight(d: Dependencies) {
  const now = d.now ?? Date.now;
  const available = () => d.production() && d.expectedFingerprint.length === 64 && /^[a-f0-9]{64}$/.test(d.expectedFingerprint) && maintenanceWindow(d.window(), now());
  async function gate(request: Request): Promise<Response | null> {
    try {
      if (await d.requireAuth(request)) return reply({ ...initial(), reason: 'unauthorized' }, 401);
      if (!available()) return reply({ ...initial(), reason: 'unavailable' }, 404);
      return null;
    } catch { return reply({ ...initial(), result: 'indeterminate', reason: 'unavailable' }, 404); }
  }
  async function POST(request: Request): Promise<Response> {
    if (request.method !== 'POST') return reply({ ...initial(), reason: 'method' }, 405);
    const denied = await gate(request); if (denied) return denied;
    const r = initial(); const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const timer = setTimeout(() => controller.abort(), RUN_MS);
    let firstRaw: string | null = null; let lastRaw: string | null = null;
    const stop = () => { if (signal.aborted || !available()) throw new Error('STOP'); };
    try {
      const configuredOrigin = d.origin();
      const origin = configuredOrigin ? new URL(configuredOrigin).origin : null;
      const url = new URL(request.url);
      if (!origin || url.origin !== origin || request.headers.get('origin') !== origin || url.search ||
          request.headers.get('sec-fetch-site') !== 'same-origin' ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
          (request.headers.has('content-length') && request.headers.get('content-length') !== '2'))
        return reply({ ...r, reason: 'input' }, 400);
      // Only the exact two-byte empty object is accepted; never buffer an arbitrary body.
      const body = request.body?.getReader(); let input = '';
      if (!body) return reply({ ...r, reason: 'input' }, 400);
      try {
        while (true) {
          const part = await bounded(body.read(), signal);
          if (part.done) break;
          if (input.length + part.value.byteLength > 2) return reply({ ...r, reason: 'input' }, 400);
          input += String.fromCharCode(...part.value);
        }
      } finally { void body.cancel().catch(() => {}); body.releaseLock(); }
      if (input !== '{}') return reply({ ...r, reason: 'input' }, 400);
      stop(); const reader = await bounded(d.reader(signal), signal);
      async function absent(ending: boolean): Promise<boolean> {
        for (const [field, key] of PRESENCE) {
          stop(); r.logical_reads++;
          const value = await bounded(reader.exists(key), signal); stop();
          if (value !== 0 && value !== 1) throw new Error('STOP');
          r[field] = value === 0 ? 'absent' : 'present';
          if (value === 1) {
            r.result = ending ? 'indeterminate' : 'blocked'; r.reason = ending ? 'changed' : 'present';
            if (ending) r.before_after_match = false;
            return false;
          }
        }
        return true;
      }
      async function source(): Promise<string | null> {
        stop(); r.logical_reads++;
        const raw = await bounded(reader.getRawString(SOURCE, SOURCE_LIMIT), signal); stop();
        if (raw === null) return null;
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > SOURCE_LIMIT) throw new Error('STOP');
        return raw;
      }
      if (!await absent(false)) return reply(r, 409);
      firstRaw = await source();
      if (firstRaw === null) return reply({ ...r, reason: 'source' }, 409);
      try { validateLegacySource(firstRaw); } catch { return reply({ ...r, reason: 'source' }, 409); }
      r.source_bytes = Buffer.byteLength(firstRaw); r.fingerprint_match = hash(firstRaw) === d.expectedFingerprint;
      const state = JSON.parse(firstRaw);
      r.phase = !Object.hasOwn(state, 'phase') ? 'missing' : typeof state.phase !== 'string' ? 'invalid' :
        PHASES.includes(state.phase) ? state.phase : 'unknown';
      if (r.phase === 'unknown' || r.phase === 'invalid') return reply({ ...r, result: 'indeterminate', reason: 'phase' }, 409);
      if (!r.fingerprint_match) return reply({ ...r, reason: 'fingerprint' }, 409);
      lastRaw = await source();
      if (lastRaw === null || lastRaw !== firstRaw || hash(lastRaw) !== d.expectedFingerprint)
        return reply({ ...r, before_after_match: false, result: 'indeterminate', reason: 'changed' }, 409);
      if (!await absent(true)) return reply(r, 409);
      stop(); return reply({ ...r, before_after_match: true, result: 'checked', reason: 'none' }, 200);
    } catch {
      return reply({ ...r, result: 'indeterminate', reason: signal.aborted ? 'timeout' : 'read_failed' }, 503);
    } finally { clearTimeout(timer); controller.abort(); firstRaw = null; lastRaw = null; }
  }
  async function GET(request: Request): Promise<Response> {
    if (request.method !== 'GET') return reply({ ...initial(), reason: 'method' }, 405);
    const denied = await gate(request); if (denied) return denied;
    const nonce = randomBytes(18).toString('base64');
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>M1 一回限り保守確認</title>
<h1>M1 固定6キー確認</h1><p>WAF・スタッフ・writer停止を維持し、実行承認がある場合だけ押してください。結果はapply許可ではありません。</p>
<button id="run">read-only確認を一回実行</button><pre id="result"></pre>
<script nonce="${nonce}">
const enums=${JSON.stringify(ENUMS)};
function safeResult(v){if(!v||typeof v!=='object'||Array.isArray(v))return false;
const fields=[...Object.keys(enums),'source_bytes','fingerprint_match','before_after_match','logical_reads'];
if(v.result==='checked'&&(v.reason!=='none'||v.fingerprint_match!==true||v.before_after_match!==true||v.logical_reads!==12||v.source_bytes===null||['not_read','unknown','invalid'].includes(v.phase)||['epoch','migration_record','session','lease','attempt'].some(k=>v[k]!=='absent')))return false;
return Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k))&&
Object.entries(enums).every(([k,values])=>values.includes(v[k]))&&
(v.source_bytes===null||Number.isSafeInteger(v.source_bytes)&&v.source_bytes>=0&&v.source_bytes<=${SOURCE_LIMIT})&&
[null,true,false].includes(v.fingerprint_match)&&[null,true,false].includes(v.before_after_match)&&
Number.isSafeInteger(v.logical_reads)&&v.logical_reads>=0&&v.logical_reads<=12;}
document.getElementById('run').addEventListener('click',async function(){this.disabled=true;
const out=document.getElementById('result');out.textContent='確認中です。再送しないでください。';
try{const r=await fetch('/api/maintenance/m1-v1/preflight',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(${RUN_MS + 5000})});
const text=await r.text();if(text.length>4096)throw 0;const value=JSON.parse(text);if(!safeResult(value))throw 0;out.textContent=JSON.stringify(value,null,2);
}catch{out.textContent='結果を確認できません。再実行せず、保守経路を再遮断してください。';}});
</script></html>`;
    return new Response(html, { headers: { ...headers(), 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
  }
  return { POST, GET };
}

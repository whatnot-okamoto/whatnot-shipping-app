// Fixed six-key observation only. No arbitrary command/key/script interface.
export const FIXED_KEYS = Object.freeze([
  'orders:workflow_epoch', 'orders:migration:diff-modal-01:v1', 'orders:refetch_state',
  'session:current', 'orders:workflow_operation_lease', 'orders:refetch_attempt',
]);
export const HTTP_MS = 15_000;
export const RESPONSE_BYTES = 2 * 1024 * 1024;
export const FIXED_LUA = `
if #KEYS~=6 or #ARGV~=0 then return redis.error_reply('M1_PREFLIGHT_RESPONSE') end
local expected={'orders:workflow_epoch','orders:migration:diff-modal-01:v1','orders:refetch_state','session:current','orders:workflow_operation_lease','orders:refetch_attempt'}
for i=1,6 do if KEYS[i]~=expected[i] then return redis.error_reply('M1_PREFLIGHT_RESPONSE') end end
local r={types={},lengths={},ttl=redis.call('PTTL',KEYS[5]),source=cjson.null}
for i=1,6 do
  r.types[i]=redis.call('TYPE',KEYS[i]).ok
  r.lengths[i]=cjson.null
  if i>=3 and r.types[i]=='string' then r.lengths[i]=redis.call('STRLEN',KEYS[i]) end
end
-- Never GET metadata-only keys. Unexpected blockers also suppress the source GET.
if r.types[1]=='none' and r.types[2]=='none' and r.types[4]=='none' and
   r.types[5]=='none' and r.ttl==-2 and r.types[6]=='none' and
   r.types[3]=='string' and r.lengths[3]<=262144 then
  r.source=redis.call('GET',KEYS[3])
end
return cjson.encode(r)
`;

// Injection is used only by imported non-network tests; the executable accepts no transport options.
export async function observeFixedKeys(endpoint, token, fetchImpl = globalThis.fetch, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_MS);
  const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal;
  let reader;
  const chunks = [];
  let buffer;
  try {
    const request = JSON.stringify(['EVAL', FIXED_LUA, FIXED_KEYS.length, ...FIXED_KEYS]);
    if (Buffer.byteLength(request) > 16 * 1024) throw new Error('M1_PREFLIGHT_REQUEST_LIMIT');
    // Promise race bounds fake/non-cooperative fetch/read too. Abort also terminates real I/O.
    const abortPromise = new Promise((_, reject) => {
      if (signal.aborted) reject(new Error('M1_PREFLIGHT_TIMEOUT'));
      else signal.addEventListener('abort', () => reject(new Error('M1_PREFLIGHT_TIMEOUT')), { once: true });
    });
    const race = promise => Promise.race([promise, abortPromise]);
    const response = await race(fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: request }));
    if (response.status !== 200 || response.redirected) throw new Error('M1_PREFLIGHT_HTTP');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > RESPONSE_BYTES))
      throw new Error('M1_PREFLIGHT_RESPONSE_LIMIT');
    if (!response.body) throw new Error('M1_PREFLIGHT_RESPONSE');
    reader = response.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('M1_PREFLIGHT_RESPONSE');
      size += value.byteLength;
      if (size > RESPONSE_BYTES) throw new Error('M1_PREFLIGHT_RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
    buffer = Buffer.concat(chunks);
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).length !== 1 || typeof envelope.result !== 'string') throw new Error('M1_PREFLIGHT_RESPONSE');
    return JSON.parse(envelope.result);
  } catch (error) {
    if (signal.aborted) throw new Error('M1_PREFLIGHT_TIMEOUT');
    throw error; // CLI boundary never renders unknown error bodies, getters, URLs or headers.
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { const cancelled = reader?.cancel(); cancelled?.catch(() => {}); } catch { /* fixed CLI output only */ }
    for (const chunk of chunks) chunk.fill(0);
    buffer?.fill(0);
    chunks.length = 0;
    endpoint = null; token = null; reader = null; buffer = null;
  }
}

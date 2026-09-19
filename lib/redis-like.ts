export type RedisSetOptions = {
  nx?: boolean;
  ex?: number;
};

export type RedisMutation =
  | { type: "set"; key: string; value: unknown }
  | { type: "set_nx"; key: string; value: unknown }
  | { type: "del"; keys: string[] }
  | { type: "sadd"; key: string; members: string[] }
  | { type: "srem"; key: string; members: string[] };

export type FencedMutationResult =
  | { applied: true; results: unknown[] }
  | { applied: false; reason: "lease_lost" };

export type FencedSessionStartResult =
  | { status: "created" }
  | { status: "session_exists" }
  | { status: "lease_lost" };

export interface RedisPipelineLike {
  get(key: string): this;
  set(key: string, value: unknown, options?: RedisSetOptions): this;
  del(...keys: string[]): this;
  sadd(key: string, ...members: string[]): this;
  srem(key: string, ...members: string[]): this;
  exec(): Promise<unknown[]>;
}

export interface RedisLike {
  /** Presence only; no value or type is returned. */
  exists(key: string): Promise<number>;
  /** Atomic, byte-preserving, bounded read. Missing/wrong-type keys reject the whole read. */
  getRawBatch(keys: string[]): Promise<string[]>;
  /** Byte-preserving STRING read; never automatically deserialize JSON. */
  getRawString(key: string, maxBytes?: number): Promise<string | null>;
  /** M1 only: compare all STRING guards, then write all values with ONE MSET. */
  workflowMset(
    guards: Array<{ key: string; expected: string | null }>,
    writes: Array<{ key: string; value: string }>
  ): Promise<boolean>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    options?: RedisSetOptions
  ): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  keys(pattern: string): Promise<string[]>;
  /**
   * Deletes key only when its current serialized string value exactly matches
   * expectedValue. A false result is reserved for a confirmed mismatch or
   * missing key; indeterminate outcomes must throw.
   */
  compareAndDelete(key: string, expectedValue: string): Promise<boolean>;
  compareAndExpire(
    key: string,
    expectedValue: string,
    ttlSeconds: number
  ): Promise<boolean>;
  /**
   * Sets targetKey only when guardKey's current serialized string value
   * exactly matches expectedGuardValue. The comparison and SET are atomic.
   * A false result guarantees that targetKey was not written by this call.
   */
  setIfValueMatches(
    guardKey: string,
    expectedGuardValue: string,
    targetKey: string,
    value: string
  ): Promise<boolean>;
  /** Applies only the closed RedisMutation vocabulary while the lease matches. */
  fencedMutate(
    leaseKey: string,
    expectedLeaseValue: string,
    mutations: RedisMutation[]
  ): Promise<FencedMutationResult>;
  /**
   * Establishes currentSessionKey with NX before applying any other write.
   * A session_exists result guarantees candidateSessionKey and refetchStateKey
   * were not changed by this operation.
   */
  fencedStartSession(
    leaseKey: string,
    expectedLeaseValue: string,
    currentSessionKey: string,
    currentSessionValue: string,
    candidateSessionKey: string,
    candidateSessionValue: unknown,
    refetchStateKey: string,
    guards?: Array<{ key: string; expected: string | null }>
  ): Promise<FencedSessionStartResult>;
  pipeline(): RedisPipelineLike;
}

export const RAW_BATCH_SCRIPT = `
if #KEYS < 1 or #KEYS > 300 then return redis.error_reply('M1_RAW_COUNT') end
local seen, values, total = {}, {}, 0
for _, key in ipairs(KEYS) do
  if string.len(key)==0 or string.len(key)>512 then return redis.error_reply('M1_RAW_KEYS') end
  if seen[key] then return redis.error_reply('M1_RAW_DUPLICATE') end
  seen[key] = true
  if redis.call('TYPE',key).ok~='string' then return redis.error_reply('M1_RAW_MISSING_OR_TYPE') end
  local v = redis.call('GET', key)
  if not v then return redis.error_reply('M1_RAW_MISSING') end
  if string.len(v)>65536 then return redis.error_reply('M1_RAW_VALUE_LIMIT') end
  total = total + string.len(v)
  if total>524288 then return redis.error_reply('M1_RAW_TOTAL_LIMIT') end
  table.insert(values, v)
end
local result = 'RAW:'..cjson.encode(values)
if string.len(cjson.encode({{result=result}}))>1048576 then return redis.error_reply('M1_RAW_RESPONSE_LIMIT') end
return result
`;

export function validateRawBatchKeys(keys: string[]): void {
  if (!keys.length || keys.length > 300 || new Set(keys).size !== keys.length ||
      keys.some(k => typeof k !== 'string' || !k || Buffer.byteLength(k)>512)) throw new Error('M1_RAW_KEYS');
}
export function validateRawBatch(keys: string[], values: unknown): asserts values is string[] {
  validateRawBatchKeys(keys);
  if (!Array.isArray(values) || values.length !== keys.length || values.some(v => typeof v !== 'string'))
    throw new Error('M1_RAW_RESPONSE');
  if (values.some(v => Buffer.byteLength(v)>65536)) throw new Error('M1_RAW_VALUE_LIMIT');
  if (values.reduce((n,v) => n+Buffer.byteLength(v),0)>524288) throw new Error('M1_RAW_TOTAL_LIMIT');
  if (Buffer.byteLength(JSON.stringify([{result:'RAW:'+JSON.stringify(values)}]))>1048576)
    throw new Error('M1_RAW_RESPONSE_LIMIT');
}

export const SESSION_START_SCRIPT = `
if #ARGV~=4 or #KEYS<4 or ARGV[1]=='' or ARGV[2]=='' then return redis.error_reply('M1_SESSION_INPUT') end
local spec = cjson.decode(ARGV[4])
local candidate = cjson.decode(ARGV[3])
if type(spec)~='table' or type(candidate)~='table' then return redis.error_reply('M1_SESSION_INPUT') end
if #KEYS>306 or #spec>305 or string.len(ARGV[3])>16384 then return redis.error_reply('M1_SESSION_LIMIT') end
local keySeen = {}
for _, key in ipairs(KEYS) do
  if key=='' or string.len(key)>512 or keySeen[key] then return redis.error_reply('M1_SESSION_KEYS') end
  keySeen[key] = true
end
local total, seen = 0, {}
for _, g in ipairs(spec) do
  if type(g)~='table' or type(g.key)~='number' or g.key%1~=0 or g.key<1 or g.key>#KEYS or
     (g.expected~=cjson.null and type(g.expected)~='string') then return redis.error_reply('M1_SESSION_GUARDS') end
  if seen[g.key] then return redis.error_reply('M1_SESSION_GUARDS') end
  seen[g.key] = true
  if g.expected~=cjson.null then total=total+string.len(g.expected) end
end
if total>524288 then return redis.error_reply('M1_SESSION_LIMIT') end
if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
if redis.call('EXISTS',KEYS[2])==1 then return 0 end
if redis.call('EXISTS',KEYS[3])==1 then return redis.error_reply('M1_SESSION_CANDIDATE_EXISTS') end
for _, g in ipairs(spec) do
  local kind=redis.call('TYPE',KEYS[g.key]).ok
  if kind~='none' and kind~='string' then return -2 end
  local v=redis.call('GET',KEYS[g.key])
  if g.expected==cjson.null then
    if v then return -2 end
  elseif v~=g.expected then return -2 end
end
local acquired=redis.call('SET',KEYS[2],ARGV[2],'NX')
if not acquired then return 0 end
redis.call('SET',KEYS[3],ARGV[3])
redis.call('DEL',KEYS[4])
return 1
`;

/** Dedicated session encoder; does not relax the refetch MSET limits. */
export function encodeSessionStart(baseKeys: string[], owner: string, sessionId: string, sessionRaw: string,
  guards: Array<{key:string; expected:string|null}>) {
  if (baseKeys.length!==4 || new Set(baseKeys).size!==4 || !owner || !sessionId ||
      typeof sessionRaw!=='string' || Buffer.byteLength(sessionRaw)>16384 ||
      guards.length>305 || new Set(guards.map(g=>g.key)).size!==guards.length ||
      guards.some(g=>g.expected!==null && typeof g.expected!=='string')) throw new Error('M1_SESSION_INPUT');
  // Parse before any write; callers cannot pass an invalid candidate payload.
  const candidate: unknown = JSON.parse(sessionRaw);
  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate)) throw new Error('M1_SESSION_INPUT');
  const keys=[...new Set([...baseKeys,...guards.map(g=>g.key)])];
  if(keys.length>306 || keys.some(k=>typeof k!=='string'||!k||Buffer.byteLength(k)>512)) throw new Error('M1_SESSION_KEYS');
  const rawBytes=guards.reduce((n,g)=>n+(g.expected===null?0:Buffer.byteLength(g.expected)),0);
  if(rawBytes>524288) throw new Error('M1_SESSION_GUARD_LIMIT');
  const args=[owner,sessionId,sessionRaw,JSON.stringify(guards.map(g=>({key:keys.indexOf(g.key)+1,expected:g.expected})))];
  const bytes=Buffer.byteLength(JSON.stringify([['eval',SESSION_START_SCRIPT,keys.length,...keys,...args]]));
  if(bytes>1048576) throw new Error('M1_SESSION_REQUEST_LIMIT');
  return {keys,args,rawBytes,bytes};
}

export const WORKFLOW_MSET_SCRIPT = `
local spec = cjson.decode(ARGV[1])
for _, guard in ipairs(spec.guards) do
  local value = redis.call('GET', KEYS[guard.key])
  if guard.expected == cjson.null then
    if value then return 0 end
  elseif value ~= guard.expected then return 0 end
end
local values = {}
for _, write in ipairs(spec.writes) do
  local kind = redis.call('TYPE', KEYS[write.key]).ok
  if kind ~= 'none' and kind ~= 'string' then return -1 end
  table.insert(values, KEYS[write.key])
  table.insert(values, write.value)
end
redis.call('MSET', unpack(values))
return 1
`;

/** Exact one-command pipeline body, including Lua and JSON escaping. No network. */
export function encodeWorkflowMset(
  guards: Array<{ key: string; expected: string | null }>,
  writes: Array<{ key: string; value: string }>
) {
  if (!writes.length || writes.length > 103 || new Set(writes.map(w => w.key)).size !== writes.length)
    throw new Error('M1_INVALID_WRITES');
  const keys = [...new Set([...guards.map(g => g.key), ...writes.map(w => w.key)])];
  if (keys.length > 106 || keys.some(k => !k || Buffer.byteLength(k) > 512))
    throw new Error('M1_KEY_LIMIT');
  const payload = JSON.stringify({
    guards: guards.map(g => ({ key: keys.indexOf(g.key) + 1, expected: g.expected })),
    writes: writes.map(w => ({ key: keys.indexOf(w.key) + 1, value: w.value })),
  });
  const bytes = Buffer.byteLength(JSON.stringify([['eval', WORKFLOW_MSET_SCRIPT, keys.length, ...keys, payload]]));
  if (bytes > 1024 * 1024) throw new Error('M1_REQUEST_LIMIT');
  return { keys, payload, bytes };
}

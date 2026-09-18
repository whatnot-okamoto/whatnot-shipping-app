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

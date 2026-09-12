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
    refetchStateKey: string
  ): Promise<FencedSessionStartResult>;
  pipeline(): RedisPipelineLike;
}

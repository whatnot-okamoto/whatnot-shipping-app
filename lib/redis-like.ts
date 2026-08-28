export type RedisSetOptions = {
  nx?: boolean;
  ex?: number;
};

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
  pipeline(): RedisPipelineLike;
}

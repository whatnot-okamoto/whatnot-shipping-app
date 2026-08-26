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
  pipeline(): RedisPipelineLike;
}

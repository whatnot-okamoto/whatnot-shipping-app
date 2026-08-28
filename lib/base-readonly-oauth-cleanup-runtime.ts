import { cleanupBaseReadonlyOAuth } from "./base-readonly-oauth-cleanup";
import { createBaseReadonlyOAuthControl } from "./base-readonly-oauth-control";
import { assertDevelopmentRedis } from "./namespaced-redis";
import { assertDevelopmentRuntime, resolveRuntimeConfig } from "./runtime-mode";
import { redis } from "./upstash";

export async function runBaseReadonlyOAuthCleanup() {
  const runtime = resolveRuntimeConfig();
  assertDevelopmentRuntime(runtime, "Development OAuth cleanup");
  assertDevelopmentRedis(redis);
  return cleanupBaseReadonlyOAuth({
    redis,
    control: createBaseReadonlyOAuthControl(redis),
  });
}

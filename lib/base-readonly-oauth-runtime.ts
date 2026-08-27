import { createBaseReadonlyOAuth } from "./base-readonly-oauth";
import { assertDevelopmentRedis } from "./namespaced-redis";
import { resolveRuntimeConfig } from "./runtime-mode";
import { redis } from "./upstash";

export function getBaseReadonlyOAuthModule() {
  const runtime = resolveRuntimeConfig();
  assertDevelopmentRedis(redis);

  return createBaseReadonlyOAuth({
    redis,
    runtime,
    config: {
      clientId: process.env.BASE_READONLY_CLIENT_ID ?? "",
      clientSecret: process.env.BASE_READONLY_CLIENT_SECRET ?? "",
      redirectUri: process.env.BASE_READONLY_REDIRECT_URI ?? "",
    },
  });
}

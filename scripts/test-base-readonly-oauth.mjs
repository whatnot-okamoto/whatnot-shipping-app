import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseReadonlyOAuthExchangeError,
  BaseReadonlyOAuthStateError,
  BaseReadonlyReauthorizationRequiredError,
  createBaseReadonlyOAuth,
} from "../lib/base-readonly-oauth.ts";
import { updateAdminSessionNonce } from "../lib/admin-session-nonce.ts";
import { MemoryRedis } from "../lib/memory-redis.ts";
import {
  createDevelopmentRedis,
  createProductionRedis,
  DEVELOPMENT_REDIS_NAMESPACE,
} from "../lib/namespaced-redis.ts";
import { resolveRuntimeConfig } from "../lib/runtime-mode.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redirectUri =
  "https://whatnot-shipping-app-git-codex-development.example.test/api/base/readonly-reauth/callback";
const requestOrigin = new URL(redirectUri).origin;
const runtime = resolveRuntimeConfig({
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
});
const productionRuntime = resolveRuntimeConfig({
  APP_ENVIRONMENT: "production",
  BASE_DATA_MODE: "production",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "production",
});

const validTokenBody = {
  access_token: "development-access-token",
  refresh_token: "development-refresh-token",
  token_type: "Bearer",
  expires_in: 3600,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness({ responseBody = validTokenBody, fetchFn, nowValue = 1_000_000 } = {}) {
  const clock = { value: nowValue };
  const raw = new MemoryRedis(() => clock.value);
  const redis = createDevelopmentRedis(raw);
  const calls = [];
  let stateCounter = 1;
  const effectiveFetch =
    fetchFn ??
    (async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responseBody);
    });
  const oauth = createBaseReadonlyOAuth({
    redis,
    runtime,
    config: {
      clientId: "development-client-id",
      clientSecret: "development-client-secret",
      redirectUri,
    },
    fetchFn: effectiveFetch,
    now: () => clock.value,
    randomStateBytes: () => new Uint8Array(32).fill(stateCounter++),
  });
  return { raw, redis, oauth, calls, clock };
}

async function start(oauth, sessionNonce = "session-nonce-a".repeat(3)) {
  const authorizationUrl = await oauth.createAuthorizationUrl({
    requestOrigin,
    sessionNonce,
  });
  const parsed = new URL(authorizationUrl);
  return { authorizationUrl: parsed, state: parsed.searchParams.get("state"), sessionNonce };
}

async function complete(oauth, state, sessionNonce, extra = "code=authorization-code") {
  return oauth.completeCallback({
    requestUrl: `${redirectUri}?state=${encodeURIComponent(state)}&${extra}`,
    sessionNonce,
  });
}

// session nonceはsign-in時だけ更新し、JWT更新では維持する。別sessionは別nonceになる。
const firstJwt = updateAdminSessionNonce({}, true, () => "a".repeat(43));
assert.equal(firstJwt.adminSessionNonce, "a".repeat(43));
assert.equal(
  updateAdminSessionNonce(firstJwt, false, () => "must-not-run").adminSessionNonce,
  "a".repeat(43)
);
const reloginJwt = updateAdminSessionNonce({}, true, () => "b".repeat(43));
const otherBrowserJwt = updateAdminSessionNonce({}, true, () => "c".repeat(43));
assert.notEqual(firstJwt.adminSessionNonce, reloginJwt.adminSessionNonce);
assert.notEqual(firstJwt.adminSessionNonce, otherBrowserJwt.adminSessionNonce);

// factoryは名前空間適用済みDevelopment Redisだけを受け付ける。
assert.throws(
  () =>
    createBaseReadonlyOAuth({
      redis: new MemoryRedis(),
      runtime,
      config: { clientId: "id", clientSecret: "secret", redirectUri },
    }),
  /namespaced Development Redis adapter/
);
assert.throws(
  () =>
    createBaseReadonlyOAuth({
      redis: createDevelopmentRedis(new MemoryRedis()),
      runtime: productionRuntime,
      config: { clientId: "id", clientSecret: "secret", redirectUri },
    }),
  /only available in the validated Development Preview runtime/
);
assert.throws(
  () =>
    createBaseReadonlyOAuth({
      redis: createProductionRedis(new MemoryRedis()),
      runtime,
      config: { clientId: "id", clientSecret: "secret", redirectUri },
    }),
  /namespaced Development Redis adapter/
);
{
  const raw = new MemoryRedis();
  const doubleWrapped = createBaseReadonlyOAuth({
    redis: createDevelopmentRedis(createDevelopmentRedis(raw)),
    runtime,
    config: { clientId: "id", clientSecret: "secret", redirectUri },
  });
  await assert.rejects(
    doubleWrapped.createAuthorizationUrl({
      requestOrigin,
      sessionNonce: "double-prefix-session".repeat(2),
    }),
    /reserved Development Redis prefix/
  );
}

// startはHTTPS・専用callback・同一originに限定し、stateをdev:v1:配下へだけ保存する。
{
  const { oauth, raw } = createHarness();
  await assert.rejects(
    oauth.createAuthorizationUrl({
      requestOrigin: "https://different.example.test",
      sessionNonce: "x".repeat(43),
    }),
    /does not match/
  );
  const { authorizationUrl, state } = await start(oauth);
  assert.equal(authorizationUrl.origin, "https://api.thebase.in");
  assert.equal(authorizationUrl.pathname, "/1/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("scope"), "read_orders");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
  assert.ok(state);
  assert.ok(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`)
  );
  assert.equal(await raw.get(`auth:base_readonly_state:${state}`), null);
}
assert.throws(
  () => {
    const raw = new MemoryRedis();
    return createBaseReadonlyOAuth({
      redis: createDevelopmentRedis(raw),
      runtime,
      config: {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: redirectUri.replace("https:", "http:"),
      },
    });
  },
  /must be an HTTPS origin/
);
assert.throws(
  () => {
    const raw = new MemoryRedis();
    return createBaseReadonlyOAuth({
      redis: createDevelopmentRedis(raw),
      runtime,
      config: {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: `${redirectUri}?unsafe=1`,
      },
    });
  },
  /without credentials, query, or fragment/
);
assert.throws(
  () => {
    const raw = new MemoryRedis();
    return createBaseReadonlyOAuth({
      redis: createDevelopmentRedis(raw),
      runtime,
      config: {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: redirectUri.replace(
          "https://",
          "https://embedded-credential@"
        ),
      },
    });
  },
  /without credentials, query, or fragment/
);

// callbackは未知parameterを無視し、state claim後に一度だけtoken exchangeする。
{
  const { oauth, raw, calls } = createHarness({
    responseBody: { ...validTokenBody, unknown_future_field: "ignored" },
  });
  const { state, sessionNonce } = await start(oauth);
  assert.equal(
    await complete(oauth, state, sessionNonce, "code=authorization-code&future=value"),
    "authorized"
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://api.thebase.in/1/oauth/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded"
  );
  const requestBody = calls[0].init.body;
  assert.equal(requestBody.get("grant_type"), "authorization_code");
  assert.equal(requestBody.get("scope"), null);
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`),
    null
  );
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state_claim:${state}`),
    "1"
  );
  const stored = await raw.get(
    `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_token`
  );
  assert.equal(stored.expectedScope, "read_orders");
  assert.equal(stored.scopeVerification, "requested_and_manual_consent");
  assert.equal(await oauth.getAccessToken(), validTokenBody.access_token);
  await assert.rejects(
    complete(oauth, state, sessionNonce),
    BaseReadonlyOAuthStateError
  );
  assert.equal(calls.length, 1);
}

// error callbackもstateを単回消費し、token endpointへは接続しない。
{
  const { oauth, calls, raw } = createHarness();
  const { state, sessionNonce } = await start(oauth);
  assert.equal(await complete(oauth, state, sessionNonce, "error=access_denied"), "denied");
  assert.equal(calls.length, 0);
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`),
    null
  );
}

// state・code・errorの重複、同時指定、session不一致、期限切れを拒否する。
for (const extra of [
  "code=a&code=b",
  "error=a&error=b",
  "code=a&error=b",
  "future=value",
]) {
  const { oauth } = createHarness();
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(complete(oauth, state, sessionNonce, extra), BaseReadonlyOAuthStateError);
}
{
  const { oauth } = createHarness();
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(
    oauth.completeCallback({
      requestUrl: `${redirectUri}?state=${state}&state=${state}&code=a`,
      sessionNonce,
    }),
    BaseReadonlyOAuthStateError
  );
}
{
  const { oauth } = createHarness();
  const { state } = await start(oauth);
  await assert.rejects(
    complete(oauth, state, "different-session-nonce".repeat(3)),
    BaseReadonlyOAuthStateError
  );
}
{
  const { oauth, clock } = createHarness();
  const { state, sessionNonce } = await start(oauth);
  clock.value += 5 * 60 * 1000;
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthStateError);
}

// token exchange失敗後もstateは再利用できない。
{
  let calls = 0;
  const { oauth } = createHarness({
    fetchFn: async () => {
      calls += 1;
      return jsonResponse({ error: "invalid_grant" }, 400);
    },
  });
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthExchangeError);
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthStateError);
  assert.equal(calls, 1);
}

// token responseは必須値を厳密検証し、scopeはread_ordersだけを許可する。
const invalidTokenBodies = [
  { ...validTokenBody, access_token: "" },
  { ...validTokenBody, refresh_token: "" },
  { ...validTokenBody, token_type: "mac" },
  { ...validTokenBody, expires_in: 0 },
  { ...validTokenBody, expires_in: 1.5 },
  { ...validTokenBody, expires_in: Number.POSITIVE_INFINITY },
  { ...validTokenBody, scope: "write_orders" },
  { ...validTokenBody, scope: "read_orders write_orders" },
  { ...validTokenBody, scope: "unknown_scope" },
];
for (const responseBody of invalidTokenBodies) {
  const { oauth } = createHarness({ responseBody });
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthExchangeError);
}
{
  const { oauth, redis } = createHarness({
    responseBody: { ...validTokenBody, token_type: "bEaReR", scope: "read_orders" },
  });
  const { state, sessionNonce } = await start(oauth);
  await complete(oauth, state, sessionNonce);
  const stored = await redis.get("auth:base_readonly_token");
  assert.equal(stored.scopeVerification, "response");
}

// refreshは初回scopeを継承し、追加scope・refresh token欠落時は保存しない。
{
  const { oauth, redis, calls } = createHarness({
    responseBody: {
      access_token: "refreshed-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3600,
    },
  });
  await redis.set("auth:base_readonly_token", {
    version: 1,
    accessToken: "expired-access",
    refreshToken: "initial-refresh",
    tokenType: "Bearer",
    expiresAt: 1,
    expectedScope: "read_orders",
    scopeVerification: "requested_and_manual_consent",
  });
  assert.equal(await oauth.getAccessToken(), "refreshed-access");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body.get("grant_type"), "refresh_token");
  const refreshed = await redis.get("auth:base_readonly_token");
  assert.equal(refreshed.expectedScope, "read_orders");
  assert.equal(refreshed.scopeVerification, "requested_and_manual_consent");
}
{
  const { oauth, redis } = createHarness({
    responseBody: {
      access_token: "refreshed-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3600,
    },
  });
  await redis.set("auth:base_readonly_token", {
    version: 1,
    accessToken: "expired-access",
    refreshToken: "initial-refresh",
    tokenType: "Bearer",
    expiresAt: 1,
    expectedScope: "read_orders",
    scopeVerification: "response",
  });
  await oauth.getAccessToken();
  const refreshed = await redis.get("auth:base_readonly_token");
  assert.equal(refreshed.scopeVerification, "response");
}
{
  const { oauth, redis } = createHarness({
    responseBody: { ...validTokenBody, scope: "read_orders write_orders" },
  });
  const original = {
    version: 1,
    accessToken: "expired-access",
    refreshToken: "initial-refresh",
    tokenType: "Bearer",
    expiresAt: 1,
    expectedScope: "read_orders",
    scopeVerification: "response",
  };
  await redis.set("auth:base_readonly_token", original);
  await assert.rejects(oauth.getAccessToken(), BaseReadonlyOAuthExchangeError);
  assert.deepEqual(await redis.get("auth:base_readonly_token"), original);
}
{
  const { oauth, redis } = createHarness({
    responseBody: {
      access_token: "refreshed-access",
      token_type: "bearer",
      expires_in: 3600,
    },
  });
  const original = {
    version: 1,
    accessToken: "expired-access",
    refreshToken: "initial-refresh",
    tokenType: "Bearer",
    expiresAt: 1,
    expectedScope: "read_orders",
    scopeVerification: "response",
  };
  await redis.set("auth:base_readonly_token", original);
  await assert.rejects(
    oauth.getAccessToken(),
    BaseReadonlyReauthorizationRequiredError
  );
  assert.deepEqual(await redis.get("auth:base_readonly_token"), original);
}
{
  const { oauth, redis } = createHarness();
  await redis.set("auth:base_readonly_token", {
    version: 1,
    accessToken: "expired-access",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: 1,
    expectedScope: "read_orders",
    scopeVerification: "response",
  });
  await assert.rejects(oauth.getAccessToken(), BaseReadonlyReauthorizationRequiredError);
}
{
  const { oauth } = createHarness();
  await assert.rejects(oauth.getAccessToken(), BaseReadonlyReauthorizationRequiredError);
}

// ProductionとDevelopmentのkey・client・routeを静的契約として分離する。
const source = async (relativePath) =>
  readFile(path.join(repositoryRoot, relativePath), "utf8");
const oauthSource = await source("lib/base-readonly-oauth.ts");
const oauthRuntimeSource = await source("lib/base-readonly-oauth-runtime.ts");
const authSource = await source("lib/auth.ts");
const baseApiSource = await source("lib/base-api.ts");
const productionStartSource = await source("app/api/base/reauth/start/route.ts");
const productionCallbackSource = await source("app/api/base/reauth/callback/route.ts");
const developmentStartSource = await source(
  "app/api/base/readonly-reauth/start/route.ts"
);
const developmentCallbackSource = await source(
  "app/api/base/readonly-reauth/callback/route.ts"
);
const developmentPageSource = await source(
  "app/orders/readonly-reauth/page.tsx"
);
const rawSdkPackage = ["@", "upstash", "/redis"].join("");
assert.equal(oauthSource.includes(rawSdkPackage), false);
assert.equal(oauthRuntimeSource.includes(rawSdkPackage), false);
assert.ok(authSource.includes("async session({ session })"));
assert.ok(authSource.includes("return session;"));
assert.equal(authSource.includes("session.adminSessionNonce"), false);
assert.equal(developmentStartSource.includes("dev:v1:"), false);
assert.equal(developmentCallbackSource.includes("dev:v1:"), false);
assert.ok(developmentPageSource.includes("isDevelopmentRuntime"));
assert.ok(developmentPageSource.includes("notFound()"));
assert.equal(oauthSource.includes("auth:base_token"), false);
assert.equal(oauthRuntimeSource.includes("BASE_CLIENT_ID"), false);
assert.equal(baseApiSource.includes("BASE_READONLY_ACCESS_TOKEN"), false);
assert.ok(productionStartSource.includes("read_orders+write_orders"));
assert.ok(productionCallbackSource.includes('"auth:base_token"'));
assert.equal(productionStartSource.includes("BASE_READONLY_CLIENT_ID"), false);
assert.equal(productionCallbackSource.includes("BASE_READONLY_CLIENT_ID"), false);

console.log("base readonly OAuth contract tests passed");

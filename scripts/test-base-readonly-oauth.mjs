import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  BaseReadonlyOAuthExchangeError,
  BaseReadonlyOAuthStateError,
  BaseReadonlyReauthorizationRequiredError,
  createBaseReadonlyOAuth,
} from "../lib/base-readonly-oauth.ts";
import {
  BaseReadonlyOAuthDisabledError,
  BaseReadonlyOAuthOwnershipError,
  createBaseReadonlyOAuthControl,
} from "../lib/base-readonly-oauth-control.ts";
import { updateAdminSessionNonce } from "../lib/admin-session-nonce.ts";
import { handleBaseReadonlyOAuthPreflight } from "../lib/base-readonly-oauth-preflight.ts";
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
const canonicalPrefix = "base-readonly-oauth:v1:";
const logicalControlKey = "auth:base_readonly_control";
const logicalTokenKey = "auth:base_readonly_token";
const physicalControlKey = `${DEVELOPMENT_REDIS_NAMESPACE}${logicalControlKey}`;
const physicalTokenKey = `${DEVELOPMENT_REDIS_NAMESPACE}${logicalTokenKey}`;
const leaseL1 = Buffer.alloc(32, 11).toString("base64url");
const leaseL2 = Buffer.alloc(32, 12).toString("base64url");

const validTokenBody = {
  access_token: "development-access-token",
  refresh_token: "development-refresh-token",
  token_type: "Bearer",
  expires_in: 3600,
};

const preflightRequest = new Request(
  "https://preview.example.test/api/base/readonly-reauth/preflight"
);
const preflightIdentity = {
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
};

async function assertPreflightResponse(response, status, bodyStatus) {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("Cache-Control"),
    "private, no-store, max-age=0"
  );
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(
    response.headers.get("Content-Type"),
    bodyStatus === null ? null : "application/json"
  );
  assert.equal(response.headers.get("Location"), null);
  assert.equal(
    await response.text(),
    bodyStatus === null ? "" : JSON.stringify({ status: bodyStatus })
  );
}

// identity不一致は認証前に404、既存認証responseは固定401へ変換する。
{
  let authenticationCalls = 0;
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: {},
    requireAuthenticated: async () => {
      authenticationCalls += 1;
      return null;
    },
  });
  await assertPreflightResponse(response, 404, null);
  assert.equal(authenticationCalls, 0);
}
{
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: preflightIdentity,
    requireAuthenticated: async () =>
      new Response("existing authentication response must not leak", {
        status: 418,
        headers: { "X-Existing-Auth": "must-not-leak" },
      }),
  });
  assert.equal(response.headers.has("X-Existing-Auth"), false);
  await assertPreflightResponse(response, 401, "UNAUTHORIZED");
}
{
  const configInspectionFailure = new Error(
    "config presence must not be inspected before authentication"
  );
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: new Proxy(preflightIdentity, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "BASE_READONLY_CLIENT_ID") {
          throw configInspectionFailure;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }),
    requireAuthenticated: async () => new Response(null, { status: 401 }),
  });
  await assertPreflightResponse(response, 401, "UNAUTHORIZED");
}

// 認証後、4変数がすべて不在ならABSENT、own propertyが1つでもあれば値を読まず停止する。
{
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: preflightIdentity,
    requireAuthenticated: async () => null,
  });
  await assertPreflightResponse(response, 200, "ABSENT");
}
{
  const inheritedOAuthConfig = Object.create({
    BASE_READONLY_CLIENT_ID: "inherited",
    BASE_READONLY_CLIENT_SECRET: "inherited",
    BASE_READONLY_REDIRECT_URI: "inherited",
    BASE_READONLY_ACCESS_TOKEN: "inherited",
  });
  Object.assign(inheritedOAuthConfig, preflightIdentity);
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: inheritedOAuthConfig,
    requireAuthenticated: async () => null,
  });
  await assertPreflightResponse(response, 200, "ABSENT");
}
for (const [name, value] of [
  ["BASE_READONLY_CLIENT_ID", ""],
  ["BASE_READONLY_CLIENT_SECRET", undefined],
  ["BASE_READONLY_REDIRECT_URI", "configured"],
  ["BASE_READONLY_ACCESS_TOKEN", "configured"],
]) {
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: { ...preflightIdentity, [name]: value },
    requireAuthenticated: async () => null,
  });
  await assertPreflightResponse(response, 409, "PRESENT_STOP");
}
{
  const environmentWithUnreadableConfig = { ...preflightIdentity };
  Object.defineProperty(
    environmentWithUnreadableConfig,
    "BASE_READONLY_CLIENT_SECRET",
    {
      enumerable: true,
      get() {
        throw new Error("config value must not be read");
      },
    }
  );
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: environmentWithUnreadableConfig,
    requireAuthenticated: async () => null,
  });
  await assertPreflightResponse(response, 409, "PRESENT_STOP");
}

// identity判定や認証の予期しない例外は設定不正へ縮退させず、固定500へ渡す。
{
  const identityFailure = new Error("unexpected identity failure");
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: new Proxy(preflightIdentity, {
      get(target, property, receiver) {
        if (property === "APP_ENVIRONMENT") throw identityFailure;
        return Reflect.get(target, property, receiver);
      },
    }),
    requireAuthenticated: async () => null,
  });
  await assertPreflightResponse(response, 500, "INTERNAL_ERROR");
}
{
  const response = await handleBaseReadonlyOAuthPreflight({
    request: preflightRequest,
    env: preflightIdentity,
    requireAuthenticated: async () => {
      throw new Error("unexpected authentication failure");
    },
  });
  await assertPreflightResponse(response, 500, "INTERNAL_ERROR");
}

function canonical(value) {
  return `${canonicalPrefix}${JSON.stringify(value)}`;
}

function enabledControl(leaseId, expiresAt) {
  return canonical({ version: 1, status: "enabled", lease_id: leaseId, expires_at: expiresAt });
}

function disabledControl(disabledAt) {
  return canonical({ version: 1, status: "disabled", disabled_at: disabledAt, reason: "cleanup" });
}

function ownedRecord(kind, leaseId, operationByte, payload) {
  return canonical({
    version: 1,
    kind,
    lease_id: leaseId,
    operation_id: Buffer.alloc(32, operationByte).toString("base64url"),
    payload,
  });
}

function parseOwned(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.startsWith(canonicalPrefix));
  return JSON.parse(value.slice(canonicalPrefix.length));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class HookedMemoryRedis extends MemoryRedis {
  afterSet = null;
  afterFencedSet = null;

  async set(key, value, options) {
    const result = await super.set(key, value, options);
    if (result === "OK" && this.afterSet) await this.afterSet(key, value);
    return result;
  }

  async setIfValueMatches(guardKey, expectedGuardValue, targetKey, value) {
    const result = await super.setIfValueMatches(
      guardKey,
      expectedGuardValue,
      targetKey,
      value
    );
    if (result && this.afterFencedSet) {
      await this.afterFencedSet(guardKey, targetKey, value);
    }
    return result;
  }

  setWithoutHook(key, value, options) {
    return super.set(key, value, options);
  }
}

async function createHarness({
  responseBody = validTokenBody,
  fetchFn,
  nowValue = 1_000_000,
  raw = new HookedMemoryRedis(),
  seedControl = true,
} = {}) {
  const clock = { value: nowValue };
  raw.now = () => clock.value;
  const redis = createDevelopmentRedis(raw);
  if (seedControl) {
    await redis.set(logicalControlKey, enabledControl(leaseL1, nowValue + 3_600_000));
  }
  const calls = [];
  let stateCounter = 1;
  let ownerCounter = 30;
  const effectiveFetch =
    fetchFn ??
    (async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responseBody);
    });
  const control = createBaseReadonlyOAuthControl(redis, {
    now: () => clock.value,
    randomOwnerBytes: () => new Uint8Array(32).fill(ownerCounter++),
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
    randomOwnerBytes: () => new Uint8Array(32).fill(ownerCounter++),
    control,
    sleep: async () => {},
  });
  return { raw, redis, control, oauth, calls, clock };
}

async function start(oauth, sessionNonce = "session-nonce-a".repeat(3)) {
  const authorizationUrl = await oauth.createAuthorizationUrl({
    requestOrigin,
    sessionNonce,
  });
  const parsed = new URL(authorizationUrl);
  return {
    authorizationUrl: parsed,
    state: parsed.searchParams.get("state"),
    sessionNonce,
  };
}

async function complete(oauth, state, sessionNonce, extra = "code=authorization-code") {
  return oauth.completeCallback({
    requestUrl: `${redirectUri}?state=${encodeURIComponent(state)}&${extra}`,
    sessionNonce,
  });
}

async function seedToken(redis, payload, leaseId = leaseL1, operationByte = 80) {
  await redis.set(logicalTokenKey, ownedRecord("token", leaseId, operationByte, payload));
}

const storedToken = (overrides = {}) => ({
  accessToken: "stored-access-token",
  refreshToken: "stored-refresh-token",
  tokenType: "Bearer",
  expiresAt: 4_000_000,
  expectedScope: "read_orders",
  scopeVerification: "response",
  ...overrides,
});

// session nonceはsign-in時だけ更新し、browserへ公開されるsessionへは複製しない。
const firstJwt = updateAdminSessionNonce({}, true, () => "a".repeat(43));
assert.equal(firstJwt.adminSessionNonce, "a".repeat(43));
assert.equal(
  updateAdminSessionNonce(firstJwt, false, () => "must-not-run").adminSessionNonce,
  "a".repeat(43)
);
assert.notEqual(
  firstJwt.adminSessionNonce,
  updateAdminSessionNonce({}, true, () => "b".repeat(43)).adminSessionNonce
);

// factoryは名前空間適用済みDevelopment Redisと正式runtimeだけを受け付ける。
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
  /validated Development Preview runtime/
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

// control欠落・不正・期限切れ・read失敗はすべてfail-closed。
{
  const { oauth } = await createHarness({ seedControl: false });
  await assert.rejects(start(oauth), BaseReadonlyOAuthDisabledError);
}
{
  const { oauth, redis } = await createHarness();
  await redis.set(logicalControlKey, "malformed-control");
  await assert.rejects(start(oauth), BaseReadonlyOAuthDisabledError);
}
{
  const { oauth, redis, clock } = await createHarness();
  await redis.set(logicalControlKey, enabledControl(leaseL1, clock.value));
  await assert.rejects(start(oauth), BaseReadonlyOAuthDisabledError);
}
{
  class FailingControlReadRedis extends MemoryRedis {
    async get(key) {
      if (key === physicalControlKey) throw new Error("sensitive backend detail");
      return super.get(key);
    }
  }
  const { oauth } = await createHarness({ raw: new FailingControlReadRedis() });
  await assert.rejects(start(oauth), (error) => {
    assert.ok(error instanceof BaseReadonlyOAuthDisabledError);
    assert.equal(error.message.includes("sensitive"), false);
    assert.equal(error.message.includes(physicalControlKey), false);
    return true;
  });
}

// opaque leaseは同じcanonical enabled recordだけを許可し、L1をL2へ持ち越せない。
{
  const { control, redis, clock } = await createHarness();
  const handleL1 = await control.captureEnabledLease();
  await redis.set(logicalControlKey, enabledControl(leaseL2, clock.value + 3_600_000));
  await assert.rejects(
    control.assertSameEnabledLease(handleL1),
    BaseReadonlyOAuthDisabledError
  );
}

// startは専用origin・read_ordersだけを使い、stateをdev:v1:配下へ保存する。
{
  const { oauth, raw } = await createHarness();
  await assert.rejects(
    oauth.createAuthorizationUrl({
      requestOrigin: "https://different.example.test",
      sessionNonce: "x".repeat(43),
    }),
    /does not match/
  );
  const { authorizationUrl, state } = await start(oauth);
  assert.equal(authorizationUrl.origin, "https://api.thebase.in");
  assert.equal(authorizationUrl.searchParams.get("scope"), "read_orders");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
  assert.ok(state);
  assert.equal(
    typeof (await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`)),
    "string"
  );
  assert.equal(await raw.get(`auth:base_readonly_state:${state}`), null);
}

// state payloadは既知fieldのcanonical順序だけを許可し、並べ替え・未知fieldを拒否する。
for (const mutatePayload of [
  (payload) => ({
    sessionNonceHash: payload.sessionNonceHash,
    purpose: payload.purpose,
    appEnvironment: payload.appEnvironment,
    vercelEnvironment: payload.vercelEnvironment,
    branch: payload.branch,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  }),
  (payload) => ({ ...payload, unknownField: "must-be-rejected" }),
]) {
  const { oauth, raw, calls } = await createHarness();
  const { state, sessionNonce } = await start(oauth);
  const stateKey = `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`;
  const envelope = parseOwned(await raw.get(stateKey));
  await raw.setWithoutHook(
    stateKey,
    canonical({ ...envelope, payload: mutatePayload(envelope.payload) })
  );
  await assert.rejects(
    complete(oauth, state, sessionNonce),
    BaseReadonlyOAuthStateError
  );
  assert.equal(calls.length, 0);
}

// token payloadもcanonical順序だけを許可し、並べ替え・未知fieldを利用しない。
for (const payload of [
  {
    refreshToken: "stored-refresh-token",
    accessToken: "stored-access-token",
    tokenType: "Bearer",
    expiresAt: 4_000_000,
    expectedScope: "read_orders",
    scopeVerification: "response",
  },
  { ...storedToken(), unknownField: "must-be-rejected" },
]) {
  const { oauth, redis } = await createHarness();
  await seedToken(redis, payload);
  await assert.rejects(
    oauth.getAccessGrant(),
    BaseReadonlyReauthorizationRequiredError
  );
}

// callbackは未知parameterを無視し、stateを単回消費してtokenを所有者付きで保存する。
{
  const { oauth, raw, calls } = await createHarness({
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
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:${state}`),
    null
  );
  const claim = parseOwned(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state_claim:${state}`)
  );
  assert.equal(claim.kind, "claim");
  const tokenEnvelope = parseOwned(await raw.get(physicalTokenKey));
  assert.equal(tokenEnvelope.kind, "token");
  assert.equal(tokenEnvelope.payload.expectedScope, "read_orders");
  assert.equal(tokenEnvelope.payload.scopeVerification, "requested_and_manual_consent");
  const grant = await oauth.getAccessGrant();
  assert.equal(await oauth.authorizeAccessGrant(grant), validTokenBody.access_token);
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthStateError);
  assert.equal(calls.length, 1);
}

// callback parameterとtoken responseを厳密検証する。
for (const extra of [
  "code=a&code=b",
  "error=a&error=b",
  "code=a&error=b",
  "future=value",
]) {
  const { oauth } = await createHarness();
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(complete(oauth, state, sessionNonce, extra), BaseReadonlyOAuthStateError);
}
for (const responseBody of [
  { ...validTokenBody, access_token: "" },
  { ...validTokenBody, refresh_token: "" },
  { ...validTokenBody, token_type: "mac" },
  { ...validTokenBody, expires_in: 0 },
  { ...validTokenBody, expires_in: 1.5 },
  { ...validTokenBody, scope: "write_orders" },
  { ...validTokenBody, scope: "read_orders write_orders" },
]) {
  const { oauth } = await createHarness({ responseBody });
  const { state, sessionNonce } = await start(oauth);
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthExchangeError);
}

// refreshは同じleaseでのみ進み、scopeを継承し、lockをowner一致時だけ解放する。
{
  const { oauth, redis, raw, calls } = await createHarness({
    responseBody: {
      access_token: "refreshed-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3600,
    },
  });
  await seedToken(redis, storedToken({ expiresAt: 1 }));
  const grant = await oauth.getAccessGrant();
  assert.equal(await oauth.authorizeAccessGrant(grant), "refreshed-access");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body.get("grant_type"), "refresh_token");
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_refresh_lock`),
    null
  );
}
{
  const { oauth, redis } = await createHarness({
    responseBody: { ...validTokenBody, scope: "read_orders write_orders" },
  });
  await seedToken(redis, storedToken({ expiresAt: 1 }));
  await assert.rejects(oauth.getAccessGrant(), BaseReadonlyOAuthExchangeError);
}
{
  const { oauth, redis } = await createHarness({
    responseBody: {
      access_token: "refreshed-access",
      token_type: "bearer",
      expires_in: 3600,
    },
  });
  await seedToken(redis, storedToken({ expiresAt: 1 }));
  await assert.rejects(oauth.getAccessGrant(), BaseReadonlyReauthorizationRequiredError);
}

// state書込み直後のdisableはstateをowner一致でrollbackし、認可URLを返さない。
{
  const { oauth, raw } = await createHarness();
  raw.afterSet = async (key) => {
    if (key.includes("auth:base_readonly_state:")) {
      raw.afterSet = null;
      await raw.setWithoutHook(physicalControlKey, disabledControl(1_000_001));
    }
  };
  await assert.rejects(start(oauth), BaseReadonlyOAuthDisabledError);
  assert.deepEqual(
    await raw.keys(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:*`),
    []
  );
  assert.equal(await raw.get(physicalControlKey), disabledControl(1_000_001));
}

// claim取得直後のdisableはclaimをrollbackし、token endpointを呼ばない。
{
  const { oauth, raw, calls } = await createHarness();
  const { state, sessionNonce } = await start(oauth);
  raw.afterSet = async (key) => {
    if (key.includes("auth:base_readonly_state_claim:")) {
      raw.afterSet = null;
      await raw.setWithoutHook(physicalControlKey, disabledControl(1_000_002));
    }
  };
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthDisabledError);
  assert.equal(calls.length, 0);
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state_claim:${state}`),
    null
  );
  assert.equal(await raw.get(physicalControlKey), disabledControl(1_000_002));
}

// refresh lock取得直後のdisableはlockをrollbackし、refreshを開始しない。
{
  const { oauth, redis, raw, calls } = await createHarness();
  await seedToken(redis, storedToken({ expiresAt: 1 }));
  raw.afterSet = async (key) => {
    if (key.endsWith("auth:base_readonly_refresh_lock")) {
      raw.afterSet = null;
      await raw.setWithoutHook(physicalControlKey, disabledControl(1_000_003));
    }
  };
  await assert.rejects(oauth.getAccessGrant(), BaseReadonlyOAuthDisabledError);
  assert.equal(calls.length, 0);
  assert.equal(
    await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_refresh_lock`),
    null
  );
}

// token fenced write直後のdisableは自分のtokenだけをrollbackし、成功を返さない。
{
  const { oauth, raw } = await createHarness();
  const { state, sessionNonce } = await start(oauth);
  raw.afterFencedSet = async (_guardKey, targetKey) => {
    if (targetKey === physicalTokenKey) {
      raw.afterFencedSet = null;
      await raw.setWithoutHook(physicalControlKey, disabledControl(1_000_004));
    }
  };
  await assert.rejects(complete(oauth, state, sessionNonce), BaseReadonlyOAuthDisabledError);
  assert.equal(await raw.get(physicalTokenKey), null);
}

// 古いleaseのfenced writeは新lease tokenを上書きせず、旧ownerのdeleteも新ownerを消さない。
{
  const raw = new MemoryRedis();
  const redis = createDevelopmentRedis(raw);
  const controlL1 = enabledControl(leaseL1, 5_000_000);
  const controlL2 = enabledControl(leaseL2, 5_000_000);
  const tokenA = ownedRecord("token", leaseL1, 91, storedToken({ accessToken: "token-a" }));
  const tokenB = ownedRecord("token", leaseL2, 92, storedToken({ accessToken: "token-b" }));
  await redis.set(logicalControlKey, controlL2);
  await redis.set(logicalTokenKey, tokenB);
  assert.equal(
    await redis.setIfValueMatches(logicalControlKey, controlL1, logicalTokenKey, tokenA),
    false
  );
  assert.equal(await redis.get(logicalTokenKey), tokenB);
  assert.equal(await redis.compareAndDelete(logicalTokenKey, tokenA), false);
  assert.equal(await redis.get(logicalTokenKey), tokenB);
  assert.equal(
    await redis.setIfValueMatches(logicalControlKey, controlL2, logicalTokenKey, tokenB),
    true
  );
}

// refresh lock／claimのABAでも旧ownerは新ownerを削除しない。
{
  const raw = new MemoryRedis();
  const redis = createDevelopmentRedis(raw);
  const lockA = ownedRecord("refresh_lock", leaseL1, 93, { createdAt: 1 });
  const lockB = ownedRecord("refresh_lock", leaseL1, 94, { createdAt: 2 });
  await redis.set("auth:base_readonly_refresh_lock", lockB);
  assert.equal(await redis.compareAndDelete("auth:base_readonly_refresh_lock", lockA), false);
  assert.equal(await redis.get("auth:base_readonly_refresh_lock"), lockB);
  const claimA = ownedRecord("claim", leaseL1, 95, { createdAt: 1 });
  const claimB = ownedRecord("claim", leaseL1, 96, { createdAt: 2 });
  await redis.set("auth:base_readonly_state_claim:opaque", claimB);
  assert.equal(await redis.compareAndDelete("auth:base_readonly_state_claim:opaque", claimA), false);
  assert.equal(await redis.get("auth:base_readonly_state_claim:opaque"), claimB);
}

// token取得後にcontrolがL2へ変われば、L1 grantは利用できない。
{
  const { oauth, redis, clock } = await createHarness();
  await seedToken(redis, storedToken());
  const grantL1 = await oauth.getAccessGrant();
  await redis.set(logicalControlKey, enabledControl(leaseL2, clock.value + 3_600_000));
  await assert.rejects(oauth.authorizeAccessGrant(grantL1), BaseReadonlyOAuthDisabledError);
}

// 原子操作の通信・script結果不明はfalseへ縮退させずthrowする。
{
  class ThrowingAtomicRedis extends MemoryRedis {
    async compareAndDelete() {
      throw new Error("backend uncertainty");
    }
  }
  const raw = new ThrowingAtomicRedis();
  const redis = createDevelopmentRedis(raw);
  await redis.set(logicalControlKey, enabledControl(leaseL1, 5_000_000));
  const control = createBaseReadonlyOAuthControl(redis, { now: () => 1_000_000 });
  const handle = await control.captureEnabledLease();
  const record = control.createOwnedRecord(handle, "claim", { createdAt: 1 });
  await assert.rejects(
    control.consumeOwnedRecord(handle, "auth:base_readonly_state_claim:opaque", record),
    BaseReadonlyOAuthOwnershipError
  );
}
{
  class ThrowingFencedRedis extends MemoryRedis {
    async setIfValueMatches() {
      throw new Error("backend uncertainty");
    }
  }
  const raw = new ThrowingFencedRedis();
  const redis = createDevelopmentRedis(raw);
  await redis.set(logicalControlKey, enabledControl(leaseL1, 5_000_000));
  const control = createBaseReadonlyOAuthControl(redis, { now: () => 1_000_000 });
  const handle = await control.captureEnabledLease();
  const record = control.createOwnedRecord(handle, "token", storedToken());
  await assert.rejects(control.saveTokenForLease(handle, record), BaseReadonlyOAuthOwnershipError);
  assert.equal(await redis.get(logicalTokenKey), null);
}

// ProductionとDevelopmentのkey・client・route・raw SDKを静的契約として分離する。
const source = async (relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8");
const oauthSource = await source("lib/base-readonly-oauth.ts");
const controlSource = await source("lib/base-readonly-oauth-control.ts");
const cleanupSource = await source("lib/base-readonly-oauth-cleanup.ts");
const oauthRuntimeSource = await source("lib/base-readonly-oauth-runtime.ts");
const authSource = await source("lib/auth.ts");
const baseApiSource = await source("lib/base-api.ts");
const productionStartSource = await source("app/api/base/reauth/start/route.ts");
const productionCallbackSource = await source("app/api/base/reauth/callback/route.ts");
const developmentStartSource = await source("app/api/base/readonly-reauth/start/route.ts");
const preflightSource = await source("lib/base-readonly-oauth-preflight.ts");
const preflightRouteSource = await source(
  "app/api/base/readonly-reauth/preflight/route.ts"
);
const preflightLoginPageSource = await source(
  "app/development/readonly-reauth/preflight-login/page.tsx"
);
const preflightLoginFormSource = await source(
  "app/development/readonly-reauth/preflight-login/preflight-login-form.tsx"
);
const rawSdkPackage = ["@", "upstash", "/redis"].join("");
for (const moduleSource of [oauthSource, controlSource, cleanupSource, oauthRuntimeSource]) {
  assert.equal(moduleSource.includes(rawSdkPackage), false);
}
assert.ok(authSource.includes("async session({ session })"));
assert.equal(authSource.includes("session.adminSessionNonce"), false);
assert.equal(developmentStartSource.includes("dev:v1:"), false);
assert.equal(oauthSource.includes("auth:base_token"), false);
assert.equal(oauthRuntimeSource.includes("BASE_CLIENT_ID"), false);
assert.equal(baseApiSource.includes("BASE_READONLY_ACCESS_TOKEN"), false);
assert.ok(productionStartSource.includes("read_orders+write_orders"));
assert.ok(productionCallbackSource.includes('"auth:base_token"'));
assert.equal(controlSource.includes("createEnabled"), false);
assert.equal(controlSource.includes("enableFor"), false);
assert.equal(cleanupSource.includes("diagnostic"), false);

// 新規route／helperの直接importと列挙した直接呼出しだけをAST契約にする。
const routeImportContract = [
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "next/server",
    clauseTypeOnly: true,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "NextRequest", local: "NextRequest", specifierTypeOnly: false },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "@/lib/auth",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "requireAuth", local: "requireAuth", specifierTypeOnly: false },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "@/lib/base-readonly-oauth-preflight",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        imported: "handleBaseReadonlyOAuthPreflight",
        local: "handleBaseReadonlyOAuthPreflight",
        specifierTypeOnly: false,
      },
    ],
  },
];
const helperImportContract = [
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "./runtime-mode",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        imported: "matchesDevelopmentPreviewRuntimeIdentity",
        local: "matchesDevelopmentPreviewRuntimeIdentity",
        specifierTypeOnly: false,
      },
    ],
  },
];
const loginPageImportContract = [
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "next/navigation",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "notFound", local: "notFound", specifierTypeOnly: false },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "@/lib/runtime-mode",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        imported: "matchesDevelopmentPreviewRuntimeIdentity",
        local: "matchesDevelopmentPreviewRuntimeIdentity",
        specifierTypeOnly: false,
      },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "./preflight-login-form",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        imported: "PreflightLoginForm",
        local: "PreflightLoginForm",
        specifierTypeOnly: false,
      },
    ],
  },
];
const loginFormImportContract = [
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "react",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "useState", local: "useState", specifierTypeOnly: false },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "react",
    clauseTypeOnly: true,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "FormEvent", local: "FormEvent", specifierTypeOnly: false },
    ],
  },
  {
    declarationKind: "ImportDeclaration",
    moduleSpecifier: "next-auth/react",
    clauseTypeOnly: false,
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      { imported: "signIn", local: "signIn", specifierTypeOnly: false },
    ],
  },
];

function parseTypeScriptSource(moduleSource, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    moduleSource,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  assert.equal(
    sourceFile.parseDiagnostics.length,
    0,
    `${fileName} must parse without diagnostics`
  );
  return sourceFile;
}

function analyzePreflightAst(moduleSource, fileName) {
  const sourceFile = parseTypeScriptSource(moduleSource, fileName);

  const imports = [];
  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const importClause = node.importClause;
      const namedBindings = importClause?.namedBindings;
      imports.push({
        declarationKind: "ImportDeclaration",
        moduleSpecifier: ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "<non-literal>",
        clauseTypeOnly: importClause?.isTypeOnly ?? null,
        defaultImport: importClause?.name?.text ?? null,
        namespaceImport:
          namedBindings && ts.isNamespaceImport(namedBindings)
            ? namedBindings.name.text
            : null,
        namedImports:
          namedBindings && ts.isNamedImports(namedBindings)
            ? namedBindings.elements.map((specifier) => ({
                imported: (specifier.propertyName ?? specifier.name).text,
                local: specifier.name.text,
                specifierTypeOnly: specifier.isTypeOnly,
              }))
            : [],
      });
      if (!importClause) violations.push("side_effect_import");
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.push(node.exportClause ? "module_reexport" : "export_star");
    }
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push("import_equals");
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "console") {
        violations.push("console_access");
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "redis") {
        violations.push("redis_access");
      }
      if (
        ts.isIdentifier(node.expression) &&
        ["localStorage", "sessionStorage"].includes(node.expression.text)
      ) {
        violations.push(`${node.expression.text}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "document" &&
        node.name.text === "cookie"
      ) {
        violations.push("document_cookie_access");
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "window" &&
        ["location", "open"].includes(node.name.text)
      ) {
        violations.push(`window_${node.name.text}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        ["location", "router", "history"].includes(node.expression.text)
      ) {
        violations.push(`${node.expression.text}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "result" &&
        ["url", "error", "status"].includes(node.name.text)
      ) {
        violations.push(`result_${node.name.text}_access`);
      }
    }
    if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "console") {
        violations.push("console_access");
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "redis") {
        violations.push("redis_access");
      }
      const elementName = ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
      if (
        ts.isIdentifier(node.expression) &&
        ["localStorage", "sessionStorage"].includes(node.expression.text)
      ) {
        violations.push(`${node.expression.text}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "document" &&
        elementName === "cookie"
      ) {
        violations.push("document_cookie_access");
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "window" &&
        ["location", "open"].includes(elementName)
      ) {
        violations.push(`window_${elementName}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        ["location", "router", "history"].includes(node.expression.text)
      ) {
        violations.push(`${node.expression.text}_access`);
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "result" &&
        ["url", "error", "status"].includes(elementName)
      ) {
        violations.push(`result_${elementName}_access`);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push("dynamic_import");
      }
      if (ts.isIdentifier(callee) && callee.text === "require") {
        violations.push("require_call");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "module" &&
        callee.name.text === "require"
      ) {
        violations.push("module_require_call");
      }
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        violations.push("direct_fetch_call");
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
        violations.push("property_fetch_call");
      }
      if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        callee.argumentExpression.text === "fetch"
      ) {
        violations.push("element_fetch_call");
      }
      if (ts.isIdentifier(callee) && callee.text === "redirect") {
        violations.push("direct_redirect_call");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ["Response", "NextResponse"].includes(callee.expression.text) &&
        callee.name.text === "redirect"
      ) {
        violations.push(`${callee.expression.text}_redirect_call`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { imports, violations };
}

function assertPreflightAstContract(moduleSource, fileName, expectedImports) {
  const analysis = analyzePreflightAst(moduleSource, fileName);
  assert.deepEqual(analysis.imports, expectedImports);
  assert.deepEqual(analysis.violations, []);
}

const allowedRouteImportFixture = [
  'import type { NextRequest } from "next/server";',
  'import { requireAuth } from "@/lib/auth";',
  'import { handleBaseReadonlyOAuthPreflight } from "@/lib/base-readonly-oauth-preflight";',
].join("\n");
const allowedHelperImportFixture =
  'import { matchesDevelopmentPreviewRuntimeIdentity } from "./runtime-mode";';
const allowedLoginPageImportFixture = [
  'import { notFound } from "next/navigation";',
  'import { matchesDevelopmentPreviewRuntimeIdentity } from "@/lib/runtime-mode";',
  'import { PreflightLoginForm } from "./preflight-login-form";',
].join("\n");
const allowedLoginFormImportFixture = [
  'import { useState } from "react";',
  'import type { FormEvent } from "react";',
  'import { signIn } from "next-auth/react";',
].join("\n");
assertPreflightAstContract(
  allowedRouteImportFixture,
  "allowed-route-imports.ts",
  routeImportContract
);
assertPreflightAstContract(
  allowedHelperImportFixture,
  "allowed-helper-import.ts",
  helperImportContract
);
assertPreflightAstContract(
  allowedLoginPageImportFixture,
  "allowed-login-page-imports.tsx",
  loginPageImportContract
);
assertPreflightAstContract(
  allowedLoginFormImportFixture,
  "allowed-login-form-imports.tsx",
  loginFormImportContract
);

const forbiddenAstFixtures = [
  ["external-import.ts", 'import Redis from "@upstash/redis";'],
  ["side-effect-import.ts", 'import "external-storage";'],
  ["module-reexport.ts", 'export { client } from "external-network";'],
  ["export-star.ts", 'export * from "external-network";'],
  ["import-equals.ts", 'import client = require("external-storage");'],
  ["dynamic-import.ts", 'const client = import("external-network");'],
  ["require.ts", 'const client = require("external-network");'],
  ["module-require.ts", 'const client = module.require("external-network");'],
  ["direct-fetch.ts", 'fetch("https://example.invalid");'],
  ["property-fetch.ts", 'client.fetch("https://example.invalid");'],
  ["element-fetch.ts", 'client["fetch"]("https://example.invalid");'],
  ["redis.ts", 'redis.get("key");'],
  ["console.ts", 'console.log("message");'],
  ["local-storage.ts", 'localStorage.setItem("key", "value");'],
  ["session-storage.ts", 'sessionStorage.setItem("key", "value");'],
  ["document-cookie.ts", "document.cookie;"],
  ["window-location.ts", 'window.location.href = "/target";'],
  ["window-open.ts", 'window.open("/target");'],
  ["location.ts", 'location.assign("/target");'],
  ["router.ts", 'router.push("/target");'],
  ["history.ts", 'history.pushState({}, "", "/target");'],
  ["result-url.ts", "result.url;"],
  ["result-error.ts", "result.error;"],
  ["result-status.ts", "result.status;"],
  ["direct-redirect.ts", 'redirect("/target");'],
  ["response-redirect.ts", 'Response.redirect("/target");'],
  ["next-response-redirect.ts", 'NextResponse.redirect("/target");'],
];
for (const [fileName, fixtureSource] of forbiddenAstFixtures) {
  assert.throws(
    () => assertPreflightAstContract(fixtureSource, fileName, []),
    (error) => error?.code === "ERR_ASSERTION"
  );
}
assert.throws(
  () => assertPreflightAstContract("import {", "parse-error.ts", []),
  (error) => error?.code === "ERR_ASSERTION"
);

assertPreflightAstContract(
  preflightRouteSource,
  "app/api/base/readonly-reauth/preflight/route.ts",
  routeImportContract
);
assertPreflightAstContract(
  preflightSource,
  "lib/base-readonly-oauth-preflight.ts",
  helperImportContract
);
assertPreflightAstContract(
  preflightLoginPageSource,
  "app/development/readonly-reauth/preflight-login/page.tsx",
  loginPageImportContract
);
assertPreflightAstContract(
  preflightLoginFormSource,
  "app/development/readonly-reauth/preflight-login/preflight-login-form.tsx",
  loginFormImportContract
);

function collectAstNodes(sourceFile, predicate) {
  const nodes = [];
  function visit(node) {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return nodes;
}

function findAstAncestor(node, predicate) {
  let ancestor = node.parent;
  while (ancestor) {
    if (predicate(ancestor)) return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

function jsxTagName(node) {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : null;
}

function jsxAttribute(node, name) {
  return node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
  );
}

function jsxStringAttribute(node, name) {
  const attribute = jsxAttribute(node, name);
  return attribute && attribute.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : null;
}

function jsxIdentifierAttribute(node, name) {
  const attribute = jsxAttribute(node, name);
  const expression =
    attribute?.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  return expression && ts.isIdentifier(expression) ? expression.text : null;
}

function assertLoginPageContract(moduleSource) {
  const fileName = "app/development/readonly-reauth/preflight-login/page.tsx";
  const sourceFile = parseTypeScriptSource(moduleSource, fileName);
  const exportedStrings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!isExported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        exportedStrings.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }
  assert.equal(exportedStrings.get("runtime"), "nodejs");
  assert.equal(exportedStrings.get("dynamic"), "force-dynamic");

  const directives = sourceFile.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(ts.isStringLiteral)
    .map((literal) => literal.text);
  assert.equal(directives.includes("use cache"), false);
  assert.equal(collectAstNodes(sourceFile, ts.isTryStatement).length, 0);

  const identityCalls = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "matchesDevelopmentPreviewRuntimeIdentity"
  );
  assert.equal(identityCalls.length, 1);
  const [identityCall] = identityCalls;
  assert.equal(identityCall.arguments.length, 1);
  assert.ok(
    ts.isPropertyAccessExpression(identityCall.arguments[0]) &&
      ts.isIdentifier(identityCall.arguments[0].expression) &&
      identityCall.arguments[0].expression.text === "process" &&
      identityCall.arguments[0].name.text === "env"
  );
  const pageFunction = findAstAncestor(identityCall, ts.isFunctionDeclaration);
  assert.ok(pageFunction);
  assert.equal(pageFunction.name?.text, "DevelopmentPreflightLoginPage");
  assert.ok(
    pageFunction.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
  assert.ok(
    pageFunction.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
    )
  );

  const notFoundCalls = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "notFound"
  );
  assert.equal(notFoundCalls.length, 1);
  assert.equal(notFoundCalls[0].arguments.length, 0);
  const identityGuards = collectAstNodes(
    pageFunction,
    (node) =>
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      node.expression.operand === identityCall
  );
  assert.equal(identityGuards.length, 1);
  assert.ok(
    notFoundCalls[0].pos >= identityGuards[0].thenStatement.pos &&
      notFoundCalls[0].end <= identityGuards[0].thenStatement.end
  );

  const formElements = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isJsxSelfClosingElement(node) && jsxTagName(node) === "PreflightLoginForm"
  );
  assert.equal(formElements.length, 1);
  assert.equal(formElements[0].attributes.properties.length, 0);
  assert.ok(identityCall.pos < notFoundCalls[0].pos);
  assert.ok(notFoundCalls[0].pos < formElements[0].pos);
}

function assertLoginFormContract(moduleSource) {
  const fileName =
    "app/development/readonly-reauth/preflight-login/preflight-login-form.tsx";
  const sourceFile = parseTypeScriptSource(moduleSource, fileName);
  const signInCalls = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "signIn"
  );
  assert.equal(signInCalls.length, 1);
  const [signInCall] = signInCalls;
  const submitFunction = findAstAncestor(signInCall, ts.isFunctionDeclaration);
  assert.ok(submitFunction);
  assert.equal(submitFunction.name?.text, "handleSubmit");
  assert.equal(signInCall.arguments.length, 2);
  assert.ok(
    ts.isStringLiteral(signInCall.arguments[0]) &&
      signInCall.arguments[0].text === "credentials"
  );
  assert.ok(ts.isObjectLiteralExpression(signInCall.arguments[1]));
  const signInProperties = signInCall.arguments[1].properties;
  assert.deepEqual(
    signInProperties.map((property) => property.name?.getText(sourceFile) ?? null),
    ["username", "password", "callbackUrl", "redirect"]
  );
  assert.ok(
    ts.isShorthandPropertyAssignment(signInProperties[0]) &&
      signInProperties[0].name.text === "username"
  );
  assert.ok(
    ts.isShorthandPropertyAssignment(signInProperties[1]) &&
      signInProperties[1].name.text === "password"
  );
  assert.ok(
    ts.isPropertyAssignment(signInProperties[2]) &&
      ts.isStringLiteral(signInProperties[2].initializer) &&
      signInProperties[2].initializer.text ===
        "/development/readonly-reauth/preflight-login"
  );
  assert.ok(
    ts.isPropertyAssignment(signInProperties[3]) &&
      signInProperties[3].initializer.kind === ts.SyntaxKind.FalseKeyword
  );

  const forms = collectAstNodes(
    sourceFile,
    (node) => ts.isJsxOpeningElement(node) && jsxTagName(node) === "form"
  );
  assert.equal(forms.length, 1);
  assert.equal(jsxIdentifierAttribute(forms[0], "onSubmit"), "handleSubmit");
  assert.equal(jsxAttribute(forms[0], "action"), undefined);
  assert.equal(jsxAttribute(forms[0], "formAction"), undefined);

  const preventDefaultCalls = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "event" &&
      node.expression.name.text === "preventDefault"
  );
  assert.equal(preventDefaultCalls.length, 1);

  const inputs = collectAstNodes(
    sourceFile,
    (node) => ts.isJsxSelfClosingElement(node) && jsxTagName(node) === "input"
  );
  assert.equal(inputs.length, 2);
  const inputsByName = new Map(
    inputs.map((input) => [jsxStringAttribute(input, "name"), input])
  );
  assert.deepEqual([...inputsByName.keys()].sort(), ["password", "username"]);
  assert.equal(jsxStringAttribute(inputsByName.get("username"), "type"), "text");
  assert.equal(
    jsxIdentifierAttribute(inputsByName.get("username"), "value"),
    "username"
  );
  assert.equal(
    jsxStringAttribute(inputsByName.get("password"), "type"),
    "password"
  );
  assert.equal(
    jsxIdentifierAttribute(inputsByName.get("password"), "value"),
    "password"
  );
  assert.equal(collectAstNodes(sourceFile, ts.isJsxSpreadAttribute).length, 0);

  const credentialIdentifiersInJsx = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isIdentifier(node) && ["username", "password"].includes(node.text)
  ).filter((identifier) => {
    let ancestor = identifier.parent;
    while (ancestor && !ts.isSourceFile(ancestor)) {
      if (ts.isJsxExpression(ancestor)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  });
  assert.equal(credentialIdentifiersInJsx.length, 2);
  for (const identifier of credentialIdentifiersInJsx) {
    assert.ok(ts.isJsxExpression(identifier.parent));
    const valueAttribute = identifier.parent.parent;
    assert.ok(ts.isJsxAttribute(valueAttribute));
    assert.equal(valueAttribute.name.getText(sourceFile), "value");
    const input = valueAttribute.parent.parent;
    assert.ok(ts.isJsxSelfClosingElement(input));
    assert.equal(
      jsxStringAttribute(input, "name"),
      identifier.text
    );
  }

  const loginStatusValues = new Set(
    collectAstNodes(sourceFile, ts.isStringLiteral)
      .map((literal) => literal.text)
      .filter((value) => /^(LOGIN_|STOP_LOGIN_)/.test(value))
  );
  assert.deepEqual([...loginStatusValues].sort(), [
    "LOGIN_ACCEPTED",
    "LOGIN_IN_PROGRESS",
    "LOGIN_REQUIRED",
    "STOP_LOGIN_ERROR",
    "STOP_LOGIN_REJECTED",
  ]);

  const acceptedConditionals = collectAstNodes(
    sourceFile,
    (node) =>
      ts.isConditionalExpression(node) &&
      ts.isStringLiteral(node.whenTrue) &&
      node.whenTrue.text === "LOGIN_ACCEPTED" &&
      ts.isStringLiteral(node.whenFalse) &&
      node.whenFalse.text === "STOP_LOGIN_REJECTED"
  );
  assert.equal(acceptedConditionals.length, 1);
  const acceptedCondition = acceptedConditionals[0].condition;
  assert.ok(ts.isBinaryExpression(acceptedCondition));
  assert.equal(
    acceptedCondition.operatorToken.kind,
    ts.SyntaxKind.EqualsEqualsEqualsToken
  );
  assert.ok(
    ts.isPropertyAccessExpression(acceptedCondition.left) &&
      ts.isIdentifier(acceptedCondition.left.expression) &&
      acceptedCondition.left.expression.text === "result" &&
      acceptedCondition.left.name.text === "ok" &&
      acceptedCondition.left.questionDotToken
  );
  assert.equal(acceptedCondition.right.kind, ts.SyntaxKind.TrueKeyword);

  const catchClauses = collectAstNodes(sourceFile, ts.isCatchClause);
  assert.equal(catchClauses.length, 1);
  assert.equal(catchClauses[0].variableDeclaration, undefined);
  assert.equal(
    collectAstNodes(
      sourceFile,
      (node) =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        jsxTagName(node) === "a"
    ).length,
    0
  );
  assert.equal(moduleSource.includes("/api/base/readonly-reauth/preflight"), false);
}

assertLoginPageContract(preflightLoginPageSource);
assertLoginFormContract(preflightLoginFormSource);
assert.ok(preflightSource.includes("Object.hasOwn(env, name)"));
assert.equal(preflightSource.includes("env[name]"), false);
assert.ok(preflightRouteSource.includes('export const runtime = "nodejs"'));
assert.ok(
  preflightRouteSource.includes('export const dynamic = "force-dynamic"')
);
for (const sensitiveFragment of [leaseL1, leaseL2, "development-access-token"]) {
  for (const errorClass of [
    new BaseReadonlyOAuthDisabledError(),
    new BaseReadonlyOAuthOwnershipError(),
  ]) {
    assert.equal(errorClass.message.includes(sensitiveFragment), false);
  }
}

console.log("base readonly OAuth contract tests passed");

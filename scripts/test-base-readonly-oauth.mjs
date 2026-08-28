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
import {
  BaseReadonlyOAuthDisabledError,
  BaseReadonlyOAuthOwnershipError,
  createBaseReadonlyOAuthControl,
} from "../lib/base-readonly-oauth-control.ts";
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
for (const sensitiveFragment of [leaseL1, leaseL2, "development-access-token"]) {
  for (const errorClass of [
    new BaseReadonlyOAuthDisabledError(),
    new BaseReadonlyOAuthOwnershipError(),
  ]) {
    assert.equal(errorClass.message.includes(sensitiveFragment), false);
  }
}

console.log("base readonly OAuth contract tests passed");

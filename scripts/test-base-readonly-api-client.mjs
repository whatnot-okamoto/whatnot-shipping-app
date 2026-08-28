import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_READONLY_GET_TIMEOUT_MS,
  BaseReadonlyApiRequestError,
  fetchDevelopmentBaseJson,
} from "../lib/base-readonly-api-client.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTimerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutFn(callback, milliseconds) {
      const handle = { callback, milliseconds };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      cleared.push(handle);
    },
  };
}

function createOAuthHarness() {
  const grant = Object.freeze({});
  const calls = [];
  return {
    grant,
    calls,
    oauth: {
      async getAccessGrant() {
        calls.push(["getAccessGrant"]);
        return grant;
      },
      async authorizeAccessGrant(receivedGrant) {
        calls.push(["authorizeAccessGrant", receivedGrant]);
        assert.equal(receivedGrant, grant);
        return "development-access-token";
      },
    },
  };
}

// 正常系は同一opaque grantを最終guardへ渡し、body読取り完了後にtimerを解除する。
{
  const timers = createTimerHarness();
  const oauthHarness = createOAuthHarness();
  const order = [];
  const result = await fetchDevelopmentBaseJson({
    oauth: oauthHarness.oauth,
    url: "https://api.thebase.in/1/orders",
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    fetchFn: async (_url, init) => {
      order.push("fetch");
      assert.equal(init.method, "GET");
      assert.equal(init.cache, "no-store");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      return {
        ok: true,
        async json() {
          order.push("json");
          assert.equal(timers.cleared.length, 0);
          return { orders: [] };
        },
      };
    },
  });
  assert.deepEqual(result, { orders: [] });
  assert.deepEqual(oauthHarness.calls.map(([name]) => name), [
    "getAccessGrant",
    "authorizeAccessGrant",
  ]);
  assert.deepEqual(order, ["fetch", "json"]);
  assert.equal(BASE_READONLY_GET_TIMEOUT_MS, 30_000);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].milliseconds, 30_000);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
}

// token取得後にcleanup／別leaseへ切り替わった場合は、業務GETを開始しない。
{
  const timers = createTimerHarness();
  const opaqueGrant = Object.freeze({});
  let fetchCalls = 0;
  await assert.rejects(
    fetchDevelopmentBaseJson({
      oauth: {
        async getAccessGrant() {
          return opaqueGrant;
        },
        async authorizeAccessGrant(grant) {
          assert.equal(grant, opaqueGrant);
          throw new Error("lease changed with internal identifiers");
        },
      },
      url: "https://api.thebase.in/1/orders",
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      fetchFn: async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
    }),
    (error) => {
      assert.ok(error instanceof BaseReadonlyApiRequestError);
      assert.equal(error.message.includes("lease"), false);
      assert.equal(error.message.includes("internal"), false);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
}

// headers受信後に成功bodyが停止しても30秒timerは生き続け、abortで汎用失敗になる。
{
  const timers = createTimerHarness();
  const oauthHarness = createOAuthHarness();
  let signal;
  const request = fetchDevelopmentBaseJson({
    oauth: oauthHarness.oauth,
    url: "https://api.thebase.in/1/orders",
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    fetchFn: async (_url, init) => {
      signal = init.signal;
      return {
        ok: true,
        json() {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("secret response body")), {
              once: true,
            });
          });
        },
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.cleared.length, 0);
  assert.equal(signal.aborted, false);
  timers.scheduled[0].callback();
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof BaseReadonlyApiRequestError);
    assert.equal(error.message.includes("secret response body"), false);
    return true;
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
}

// error body読取りも同じtimeoutで覆い、本文や実注文相当値を外へ出さない。
{
  const timers = createTimerHarness();
  const oauthHarness = createOAuthHarness();
  let signal;
  const request = fetchDevelopmentBaseJson({
    oauth: oauthHarness.oauth,
    url: "https://api.thebase.in/1/orders",
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    fetchFn: async (_url, init) => {
      signal = init.signal;
      return {
        ok: false,
        text() {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("customer-order-body")), {
              once: true,
            });
          });
        },
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  timers.scheduled[0].callback();
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof BaseReadonlyApiRequestError);
    assert.equal(error.message.includes("customer-order-body"), false);
    return true;
  });
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
}

// Productionの既存GETにはDevelopment timeout helperやsignalを混ぜない。
const baseApiSource = await readFile(path.join(repositoryRoot, "lib/base-api.ts"), "utf8");
const productionFetchBlocks = baseApiSource.match(/const token = await getBaseToken\(\);[\s\S]*?const data/g) ?? [];
assert.equal(productionFetchBlocks.length, 2);
for (const block of productionFetchBlocks) {
  assert.equal(block.includes("signal:"), false);
  assert.equal(block.includes("AbortSignal"), false);
  assert.equal(block.includes("fetchDevelopmentBaseJson"), false);
}

console.log("base readonly API client contract tests passed");

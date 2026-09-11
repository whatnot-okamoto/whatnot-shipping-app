import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { analyzePartialCancellationV2 } from "../lib/partial-cancel-diagnostic-v2.ts";
import { createPartialCancelProductionDiagnosticPost } from "../lib/partial-cancel-production-diagnostic.ts";
import { partialCancelFixture } from "./fixtures/partial-cancel-diagnostic-fixtures.mjs";

const routePath = fileURLToPath(
  new URL(
    "../app/api/receipts/partial-cancel-diagnostic/route.ts",
    import.meta.url
  )
);

function assertNoStore(response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Vary"), "Cookie");
}

function makeRequest(body) {
  return new Request("https://example.invalid/api/receipts/partial-cancel-diagnostic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDependencies(overrides = {}) {
  return {
    requireAuth: async () => null,
    isProductionRuntime: () => true,
    fetchOrderDetail: async () => structuredClone(partialCancelFixture),
    analyzeOrder: analyzePartialCancellationV2,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("real fetch is forbidden in this test");
};

try {
  {
    const calls = [];
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        requireAuth: async () => {
          calls.push("auth");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        },
        isProductionRuntime: () => {
          calls.push("runtime");
          return true;
        },
      })
    );
    const request = { json: () => assert.fail("body must not be read") };
    const response = await post(request);
    assert.equal(response.status, 401);
    assert.deepEqual(calls, ["auth"]);
    assertNoStore(response);
  }

  {
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        requireAuth: async () => {
          throw new Error("AUTH_SECRET_MUST_NOT_ESCAPE");
        },
      })
    );
    const request = { json: () => assert.fail("body must not be read") };
    const response = await post(request);
    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.equal(responseText.includes("AUTH_SECRET_MUST_NOT_ESCAPE"), false);
    assertNoStore(response);
  }

  {
    let fetchCount = 0;
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        isProductionRuntime: () => false,
        fetchOrderDetail: async () => {
          fetchCount += 1;
          return partialCancelFixture;
        },
      })
    );
    const request = { json: () => assert.fail("body must not be read") };
    const response = await post(request);
    assert.equal(response.status, 404);
    assert.equal(fetchCount, 0);
    assertNoStore(response);
  }

  {
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        isProductionRuntime: () => {
          throw new Error("configuration detail must not escape");
        },
      })
    );
    const response = await post(makeRequest({ unique_key: "SAFE-ID" }));
    assert.equal(response.status, 404);
    assert.equal(JSON.stringify(await response.json()).includes("configuration"), false);
    assertNoStore(response);
  }

  for (const body of [
    null,
    {},
    { unique_key: "" },
    { unique_key: "contains space" },
    { unique_key: "SAFE-ID", extra: true },
    { unique_key: "A".repeat(129) },
  ]) {
    let fetchCount = 0;
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        fetchOrderDetail: async () => {
          fetchCount += 1;
          return partialCancelFixture;
        },
      })
    );
    const response = await post(makeRequest(body));
    assert.equal(response.status, 400);
    assert.equal(fetchCount, 0);
    assertNoStore(response);
  }

  {
    const post = createPartialCancelProductionDiagnosticPost(makeDependencies());
    const request = new Request("https://example.invalid", {
      method: "POST",
      body: "not-json",
    });
    const response = await post(request);
    assert.equal(response.status, 400);
    assertNoStore(response);
  }

  {
    const suppliedOrderId = "ORDER_ID_MUST_NOT_APPEAR";
    let fetchCount = 0;
    let receivedOrderId = "";
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        fetchOrderDetail: async (uniqueKey) => {
          fetchCount += 1;
          receivedOrderId = uniqueKey;
          return structuredClone(partialCancelFixture);
        },
      })
    );
    const response = await post(makeRequest({ unique_key: suppliedOrderId }));
    const responseText = await response.text();
    const result = JSON.parse(responseText);
    assert.equal(response.status, 200);
    assert.equal(fetchCount, 1);
    assert.equal(receivedOrderId, suppliedOrderId);
    assert.equal(result.diagnostic.cancellationCandidate, "partial_cancel");
    assert.equal(result.diagnostic.outcome, "pass_enum_complete");
    assert.equal(responseText.includes(suppliedOrderId), false);
    assert.equal(responseText.includes("MUST_NOT_APPEAR_IN_OUTPUT"), false);
    assert.equal(/[0-9]{3,}/.test(responseText), false);
    assertNoStore(response);
  }

  {
    const post = createPartialCancelProductionDiagnosticPost(
      makeDependencies({
        fetchOrderDetail: async () => {
          throw new Error("SECRET_TOKEN_ORDER_PERSON_AMOUNT");
        },
      })
    );
    const response = await post(makeRequest({ unique_key: "SAFE-ID" }));
    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.equal(responseText.includes("SECRET_TOKEN_ORDER_PERSON_AMOUNT"), false);
    assertNoStore(response);
  }

  const routeSource = await readFile(routePath, "utf8");
  for (const required of [
    'export const runtime = "nodejs"',
    'export const dynamic = "force-dynamic"',
    "requireAuth,",
    "isProductionRuntime(resolveRuntimeConfig())",
    "fetchOrderDetail,",
    "analyzeOrder: analyzePartialCancellationV2",
  ]) {
    assert.equal(routeSource.includes(required), true, `route wiring missing: ${required}`);
  }
  assert.equal(routeSource.includes("console."), false);

  console.log("partial-cancel production route tests: PASS");
} finally {
  globalThis.fetch = realFetch;
}

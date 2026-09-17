import assert from "node:assert/strict";

const { runInitAndRefetch } = await import(
  "../app/orders/components/init-and-refetch-flow.ts"
);

const repeatedUninitializedResult = {
  refetch_cycle_id: "cycle-next",
  has_diff: true,
  has_new_uninitialized: true,
  new_uninitialized_count: 1,
  first_absence_count: 23,
  diff_summary: [],
};
const calls = [];
const fetchFn = async (input, init) => {
  calls.push({ input: String(input), init });
  if (String(input) === "/api/orders/init") {
    return Response.json({ success: true, status: "completed" });
  }
  return Response.json({
    success: true,
    diff_result: repeatedUninitializedResult,
  });
};

const result = await runInitAndRefetch("cycle-current", fetchFn);
assert.equal(calls.length, 2);
assert.equal(calls[0].input, "/api/orders/init");
assert.equal(calls[1].input, "/api/orders/refetch");
assert.equal(
  result.success,
  false,
  "a successful refetch that still reports an uninitialized order must be visible as incomplete"
);
assert.match(result.error, /未初期化|初期化.*完了/);
assert.ok(calls[0].init.signal instanceof AbortSignal);
assert.equal(calls[0].init.signal, calls[1].init.signal);

const completedResult = await runInitAndRefetch("cycle-complete", async (input) => {
  if (String(input) === "/api/orders/init") {
    return Response.json({ success: true, status: "completed" });
  }
  return Response.json({
    success: true,
    diff_result: {
      ...repeatedUninitializedResult,
      has_new_uninitialized: false,
      new_uninitialized_count: 0,
    },
  });
});
assert.equal(completedResult.success, true);

const explicitInitFailure = await runInitAndRefetch("cycle-init-failure", async () =>
  Response.json(
    { success: false, message: "fixture init failure" },
    { status: 500 }
  )
);
assert.deepEqual(explicitInitFailure, {
  success: false,
  error: "fixture init failure",
});

const explicitRefetchFailure = await runInitAndRefetch(
  "cycle-refetch-failure",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "completed" });
    }
    return Response.json(
      { success: false, error: "fixture refetch failure" },
      { status: 409 }
    );
  }
);
assert.deepEqual(explicitRefetchFailure, {
  success: false,
  error: "fixture refetch failure",
});

const contradictoryHttpFailure = await runInitAndRefetch(
  "cycle-http-failure",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "completed" });
    }
    return Response.json(
      {
        success: true,
        diff_result: {
          ...repeatedUninitializedResult,
          has_new_uninitialized: false,
          new_uninitialized_count: 0,
        },
      },
      { status: 500 }
    );
  }
);
assert.equal(contradictoryHttpFailure.success, false);

const nonJsonRefetch = await runInitAndRefetch("cycle-non-json", async (input) => {
  if (String(input) === "/api/orders/init") {
    return Response.json({ success: true, status: "completed" });
  }
  return new Response("not-json", { status: 502 });
});
assert.equal(nonJsonRefetch.success, false);
assert.equal(nonJsonRefetch.error, "ネットワークエラーが発生しました");

async function withinGuard(promise, scenario, timeoutMs = 250) {
  let guardTimer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error(`${scenario} exceeded ${timeoutMs}ms guard`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(guardTimer);
  }
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    const rejectForAbort = () =>
      reject(new DOMException("fixture request aborted", "AbortError"));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
  });
}

const nativeAbortTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => nativeAbortTimeout(25);
try {
  const timeoutResult = await withinGuard(
    runInitAndRefetch("cycle-timeout", (_input, init) =>
      waitForAbort(init?.signal)
    ),
    "init-auto-refetch-client-timeout"
  );
  assert.equal(timeoutResult.success, false);
  assert.match(timeoutResult.error, /時間内|タイムアウト/);
} finally {
  AbortSignal.timeout = nativeAbortTimeout;
}

console.log("init auto-refetch UI tests passed");

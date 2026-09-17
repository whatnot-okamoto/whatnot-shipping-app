import assert from "node:assert/strict";

const { runInitAndRefetch } = await import(
  "../app/orders/components/init-and-refetch-flow.ts"
);
const { getInitializationActionView } = await import(
  "../app/orders/components/diff-confirm-view-policy.ts"
);

const repeatedUninitializedResult = {
  refetch_cycle_id: "cycle-next",
  has_diff: true,
  has_new_uninitialized: true,
  new_uninitialized_count: 1,
  recovery_status: "fresh",
  can_initialize: true,
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
assert.equal(result.requiresReload, true);
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
      can_initialize: false,
    },
  });
});
assert.equal(completedResult.success, true);

const emptyCurrentOrdersResult = await runInitAndRefetch(
  "cycle-empty-source",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "empty_current_orders" });
    }
    return Response.json({
      success: true,
      diff_result: {
        ...repeatedUninitializedResult,
        refetch_cycle_id: "cycle-empty-current",
        has_diff: false,
        has_new_uninitialized: false,
        new_uninitialized_count: 0,
        can_initialize: false,
        resolved_uninitialized_count: 11,
        resolved_uninitialized_reason: "not_in_current_open_orders",
      },
    });
  }
);
assert.equal(emptyCurrentOrdersResult.success, true);
assert.equal(
  emptyCurrentOrdersResult.diffResult.resolved_uninitialized_count,
  11
);

const orderAppearedAfterEmptyInit = await runInitAndRefetch(
  "cycle-empty-race",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "empty_current_orders" });
    }
    return Response.json({ success: true, diff_result: repeatedUninitializedResult });
  }
);
assert.equal(orderAppearedAfterEmptyInit.success, false);
assert.equal(orderAppearedAfterEmptyInit.requiresReload, true);
assert.match(orderAppearedAfterEmptyInit.error, /未初期化|再読み込み/);

const malformedEmptyAudit = await runInitAndRefetch(
  "cycle-empty-malformed-audit",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "empty_current_orders" });
    }
    return Response.json({
      success: true,
      diff_result: {
        ...repeatedUninitializedResult,
        has_new_uninitialized: false,
        new_uninitialized_count: 0,
        can_initialize: false,
        resolved_uninitialized_count: 11,
      },
    });
  }
);
assert.equal(malformedEmptyAudit.success, false);
assert.equal(malformedEmptyAudit.requiresReload, true);

const explicitInitFailure = await runInitAndRefetch("cycle-init-failure", async () =>
  Response.json(
    { success: false, message: "fixture init failure" },
    { status: 500 }
  )
);
assert.deepEqual(explicitInitFailure, {
  success: false,
  error: "fixture init failure",
  requiresReload: true,
});

let unsafeInitCalls = 0;
const unsafeInitializationResult = await runInitAndRefetch(
  "cycle-stale-ui",
  async () => {
    unsafeInitCalls += 1;
    return Response.json(
      {
        success: false,
        error_code: "unsafe_initialization_state",
        message:
          "保存状態の整合性を安全に確認できません。再読み込みしても続く場合は管理者へ連絡してください。",
      },
      { status: 409 }
    );
  }
);
assert.equal(unsafeInitCalls, 1, "unsafe init must not continue to automatic refetch");
assert.equal(unsafeInitializationResult.success, false);
assert.equal(unsafeInitializationResult.requiresReload, true);
assert.match(unsafeInitializationResult.error, /再読み込み/);
assert.match(unsafeInitializationResult.error, /管理者/);
assert.deepEqual(
  getInitializationActionView({
    has_new_uninitialized: true,
    can_initialize: true,
    recovery_status: "fresh",
    requires_reload: unsafeInitializationResult.requiresReload,
  }),
  {
    visible: true,
    disabled: true,
    label: "再読み込み後に状態を確認してください",
  },
  "a stale-UI 409 must not restore a retryable initialization button"
);

let reloadAttempt = 0;
const partialThenReloadedResume = async (input) => {
  if (String(input) === "/api/orders/init") {
    reloadAttempt += 1;
    if (reloadAttempt === 1) {
      return Response.json({
        success: false,
        status: "partial_failed",
        message: "再読み込みして状態を確認してください。",
      });
    }
    return Response.json({ success: true, status: "completed" });
  }
  return Response.json({
    success: true,
    diff_result: {
      ...repeatedUninitializedResult,
      has_new_uninitialized: false,
      new_uninitialized_count: 0,
      can_initialize: false,
    },
  });
};
const partialBeforeReload = await runInitAndRefetch(
  "cycle-partial-resume",
  partialThenReloadedResume
);
assert.equal(partialBeforeReload.success, false);
assert.equal(partialBeforeReload.requiresReload, true);
const resumedAfterReload = await runInitAndRefetch(
  "cycle-partial-resume",
  partialThenReloadedResume
);
assert.equal(resumedAfterReload.success, true);

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
  requiresReload: true,
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
          can_initialize: false,
        },
      },
      { status: 500 }
    );
  }
);
assert.equal(contradictoryHttpFailure.success, false);

const malformedInitSuccess = await runInitAndRefetch(
  "cycle-malformed-init",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true });
    }
    return Response.json({ success: true, diff_result: repeatedUninitializedResult });
  }
);
assert.equal(malformedInitSuccess.success, false);
assert.equal(malformedInitSuccess.requiresReload, true);

const malformedRefetchSuccess = await runInitAndRefetch(
  "cycle-malformed-refetch",
  async (input) => {
    if (String(input) === "/api/orders/init") {
      return Response.json({ success: true, status: "completed" });
    }
    return Response.json({
      success: true,
      diff_result: {
        refetch_cycle_id: "cycle-next",
        has_diff: false,
        has_new_uninitialized: false,
        new_uninitialized_count: -1,
      },
    });
  }
);
assert.equal(malformedRefetchSuccess.success, false);
assert.equal(malformedRefetchSuccess.requiresReload, true);

const nonJsonRefetch = await runInitAndRefetch("cycle-non-json", async (input) => {
  if (String(input) === "/api/orders/init") {
    return Response.json({ success: true, status: "completed" });
  }
  return new Response("not-json", { status: 502 });
});
assert.equal(nonJsonRefetch.success, false);
assert.match(nonJsonRefetch.error, /応答内容|再読み込み/);
assert.equal(nonJsonRefetch.requiresReload, true);

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

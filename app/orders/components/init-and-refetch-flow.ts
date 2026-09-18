type InitApiResponse = {
  success: boolean;
  status?: string;
  message?: string;
  error?: string;
};

type RefetchApiResponse<TDiffResult> = {
  success: boolean;
  diff_result?: TDiffResult;
  error?: string;
};

export type InitAndRefetchFlowResult<TDiffResult> =
  | { success: true; diffResult: TDiffResult }
  | { success: false; error: string; requiresReload: true };

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export const INIT_AUTO_REFETCH_TIMEOUT_MS = 300_000;

const RELOAD_REQUIRED_ERROR =
  "応答内容を確認できませんでした。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseErrorMessage(
  value: Record<string, unknown> | null
): string | null {
  if (typeof value?.message === "string") return value.message;
  if (typeof value?.error === "string") return value.error;
  return null;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDiffItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.unique_key === "string" &&
    ["item_changed", "cancelled", "fee_changed", "new_order", "disappeared", "other"].includes(
      String(value.diff_type)
    ) &&
    typeof value.description === "string" &&
    ["info", "warning", "blocking"].includes(String(value.severity))
  );
}

function isDiffResultResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.refetch_cycle_id !== "string" ||
    value.refetch_cycle_id.length === 0 ||
    typeof value.has_diff !== "boolean" ||
    typeof value.has_new_uninitialized !== "boolean" ||
    !(
      value.new_uninitialized_count === null ||
      isNonNegativeSafeInteger(value.new_uninitialized_count)
    ) ||
    !Array.isArray(value.diff_summary) ||
    !value.diff_summary.every(isDiffItem) ||
    typeof value.can_initialize !== "boolean" ||
    !["fresh", "resuming_partial", "conflict", "confirmed"].includes(
      String(value.recovery_status)
    )
  ) {
    return false;
  }
  for (const key of ["first_absence_count", "cycle_not_in_open_orders_count"]) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) {
      return false;
    }
  }
  const hasResolvedCount = value.resolved_uninitialized_count !== undefined;
  const hasResolvedReason = value.resolved_uninitialized_reason !== undefined;
  if (hasResolvedCount !== hasResolvedReason) return false;
  if (
    hasResolvedCount &&
    !(
      isNonNegativeSafeInteger(value.resolved_uninitialized_count) &&
      Number(value.resolved_uninitialized_count) > 0 &&
      value.resolved_uninitialized_reason === "not_in_current_open_orders"
    )
  ) {
    return false;
  }
  if (
    value.failed_unique_keys !== undefined &&
    (!Array.isArray(value.failed_unique_keys) ||
      !value.failed_unique_keys.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  return (
    (value.recovery_message === undefined ||
      typeof value.recovery_message === "string") &&
    (value.can_confirm === undefined || typeof value.can_confirm === "boolean") &&
    (value.has_fetch_failures === undefined ||
      typeof value.has_fetch_failures === "boolean")
  );
}

function failure(error: string): InitAndRefetchFlowResult<never> {
  return { success: false, error, requiresReload: true };
}

export async function runInitAndRefetch<TDiffResult>(
  refetchCycleId: string,
  fetchFn: FetchLike = fetch
): Promise<InitAndRefetchFlowResult<TDiffResult>> {
  const signal = AbortSignal.timeout(INIT_AUTO_REFETCH_TIMEOUT_MS);
  try {
    const initRes = await fetchFn("/api/orders/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refetch_cycle_id: refetchCycleId }),
      signal,
    });
    let initData: InitApiResponse | null = null;
    let initRecord: Record<string, unknown> | null = null;
    try {
      const rawInitData: unknown = await initRes.json();
      if (!isRecord(rawInitData) || typeof rawInitData.success !== "boolean") {
        return failure(RELOAD_REQUIRED_ERROR);
      }
      initRecord = rawInitData;
      initData = rawInitData as InitApiResponse;
    } catch {
      return failure(RELOAD_REQUIRED_ERROR);
    }

    if (!initRes.ok || !initData?.success) {
      return failure(
        responseErrorMessage(initRecord) || RELOAD_REQUIRED_ERROR
      );
    }
    if (
      initData.status !== "completed" &&
      initData.status !== "empty_current_orders"
    ) {
      return failure(RELOAD_REQUIRED_ERROR);
    }

    const refetchRes = await requestM1Refetch(fetchFn, signal, refetchCycleId);
    let refetchData: RefetchApiResponse<TDiffResult> | null = null;
    let refetchRecord: Record<string, unknown> | null = null;
    try {
      const rawRefetchData: unknown = await refetchRes.json();
      if (!isRecord(rawRefetchData) || typeof rawRefetchData.success !== "boolean") {
        return failure(RELOAD_REQUIRED_ERROR);
      }
      refetchRecord = rawRefetchData;
      refetchData = rawRefetchData as RefetchApiResponse<TDiffResult>;
    } catch {
      return failure(RELOAD_REQUIRED_ERROR);
    }
    if (!refetchRes.ok || !refetchData.success) {
      return failure(responseErrorMessage(refetchRecord) || RELOAD_REQUIRED_ERROR);
    }
    const diffResult = refetchData.diff_result;
    if (!isDiffResultResponse(diffResult)) {
      return failure(RELOAD_REQUIRED_ERROR);
    }

    const completion = diffResult as {
      has_new_uninitialized?: unknown;
    };
    if (completion.has_new_uninitialized === true) {
      return failure(
        "初期化後も未初期化の注文が残っています。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。"
      );
    }

    return { success: true, diffResult: diffResult as TDiffResult };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    if (
      signal.aborted ||
      errorName === "AbortError" ||
      errorName === "TimeoutError"
    ) {
      return failure(
        "処理が時間内に完了しませんでした。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。"
      );
    }
    return failure(
      "ネットワークエラーが発生しました。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。"
    );
  }
}

/** Each explicit retry uses fresh compare tokens; transport ambiguity is inspected first. */
export async function requestM1Refetch(fetchFn: FetchLike = fetch, signal?: AbortSignal, sourceCycle?: string): Promise<Response> {
  const read = await fetchFn('/api/orders/refetch', { signal, cache: 'no-store' });
  if (!read.ok) return read;
  const context: unknown = await read.json();
  if (!isRecord(context) || context.success !== true || typeof context.workflow_epoch !== 'string' ||
      !Number.isSafeInteger(context.source_publication_revision) ||
      !(context.source_cycle_id === null || typeof context.source_cycle_id === 'string') ||
      !(context.previous_attempt_id === null || typeof context.previous_attempt_id === 'string'))
    return Response.json({ success: false, error: RELOAD_REQUIRED_ERROR }, { status: 409 });
  if (sourceCycle && context.source_cycle_id !== sourceCycle)
    return Response.json({ success: false, error: RELOAD_REQUIRED_ERROR }, { status: 409 });
  if (context.attempt_status === 'published' && !context.diff_confirmed_flag && !context.post_init_refetch_ready)
    return fetchFn('/api/orders/refetch?request_id=' + encodeURIComponent(String(context.previous_attempt_id)), { signal, cache: 'no-store' });
  const request = { request_id: crypto.randomUUID(), workflow_epoch: context.workflow_epoch,
    source_cycle_id: context.source_cycle_id, source_publication_revision: context.source_publication_revision,
    previous_attempt_id: context.previous_attempt_id };
  try {
    const response = await fetchFn('/api/orders/refetch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal });
    // Consume a clone here so body-loss also follows the same inspection path.
    await response.clone().json();
    return response;
  } catch {
    const inspection = await fetchFn('/api/orders/refetch?request_id=' + encodeURIComponent(request.request_id),
      { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const body = await inspection.clone().json();
    if (inspection.ok && body.success && body.diff_result) return inspection;
    return Response.json({ success: false, error: RELOAD_REQUIRED_ERROR }, { status: 409 });
  }
}

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
    !value.diff_summary.every(isDiffItem)
  ) {
    return false;
  }
  for (const key of ["first_absence_count", "cycle_not_in_open_orders_count"]) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) {
      return false;
    }
  }
  if (
    value.failed_unique_keys !== undefined &&
    (!Array.isArray(value.failed_unique_keys) ||
      !value.failed_unique_keys.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  if (
    value.recovery_status !== undefined &&
    !["fresh", "resuming_partial", "conflict", "confirmed"].includes(
      String(value.recovery_status)
    )
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
    if (initData.status !== "completed") {
      return failure(RELOAD_REQUIRED_ERROR);
    }

    const refetchRes = await fetchFn("/api/orders/refetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_refetch_cycle_id: refetchCycleId }),
      signal,
    });
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

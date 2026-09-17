type InitApiResponse = {
  success: boolean;
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
  | { success: false; error: string };

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export const INIT_AUTO_REFETCH_TIMEOUT_MS = 120_000;

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
    try {
      initData = (await initRes.json()) as InitApiResponse;
    } catch {
      return {
        success: false,
        error: "初期化に失敗しました。時間をおいて再実行してください。",
      };
    }

    if (!initRes.ok || !initData?.success) {
      return {
        success: false,
        error:
          initData?.message ||
          initData?.error ||
          "初期化に失敗しました。時間をおいて再実行してください。",
      };
    }

    const refetchRes = await fetchFn("/api/orders/refetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_refetch_cycle_id: refetchCycleId }),
      signal,
    });
    const refetchData = (await refetchRes.json()) as RefetchApiResponse<TDiffResult>;
    if (!refetchRes.ok || !refetchData.success || !refetchData.diff_result) {
      return {
        success: false,
        error: refetchData.error ?? "再取得に失敗しました",
      };
    }

    const completion = refetchData.diff_result as {
      has_new_uninitialized?: unknown;
    };
    if (completion.has_new_uninitialized === true) {
      return {
        success: false,
        error:
          "初期化後も未初期化の注文が残っています。再押下せず、画面を再読み込みして状態を確認してください。",
      };
    }

    return { success: true, diffResult: refetchData.diff_result };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    if (
      signal.aborted ||
      errorName === "AbortError" ||
      errorName === "TimeoutError"
    ) {
      return {
        success: false,
        error:
          "処理が時間内に完了しませんでした。再押下せず、画面を再読み込みして状態を確認してください。",
      };
    }
    return { success: false, error: "ネットワークエラーが発生しました" };
  }
}

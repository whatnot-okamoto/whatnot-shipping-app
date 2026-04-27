"use client";

import { useState } from "react";

export type DiffItem = {
  unique_key: string;
  diff_type: "item_changed" | "cancelled" | "fee_changed" | "new_order" | "disappeared" | "other";
  description: string;
  severity: "info" | "warning" | "blocking";
};

export type DiffResult = {
  has_diff: boolean;
  has_new_uninitialized: boolean;
  new_uninitialized_count: number;
  diff_summary: DiffItem[];
};

type Props = {
  initialDiffResult: DiffResult;
  /** 差分確認完了後に呼ぶ（モーダルを閉じ、注文一覧を再取得） */
  onConfirmed: () => void;
};

type RefetchApiResponse = {
  success: boolean;
  diff_result?: DiffResult;
  error?: string;
};

const SEVERITY_CLASS: Record<DiffItem["severity"], string> = {
  blocking: "text-red-700 bg-red-50 border-l-4 border-red-400",
  warning:  "text-yellow-700 bg-yellow-50 border-l-4 border-yellow-400",
  info:     "text-gray-600 bg-gray-50 border-l-4 border-gray-300",
};

const SEVERITY_LABEL: Record<DiffItem["severity"], string> = {
  blocking: "要対応",
  warning:  "注意",
  info:     "情報",
};

export default function DiffConfirmModal({ initialDiffResult, onConfirmed }: Props) {
  const [diffResult, setDiffResult] = useState<DiffResult>(initialDiffResult);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { has_diff, has_new_uninitialized, new_uninitialized_count, diff_summary } = diffResult;

  /** 差分確認APIを呼び出して完了する */
  const handleConfirm = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const res = await fetch("/api/orders/diff-confirm", { method: "POST" });
      const data = await res.json() as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error ?? "差分確認に失敗しました");
        return;
      }
      onConfirmed();
    } catch {
      setError("ネットワークエラーが発生しました");
    } finally {
      setIsProcessing(false);
    }
  };

  /** 初期化を実行し、自動で再取得を再実行してモーダルを更新する */
  const handleInitAndRefetch = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      // POST /api/orders/init
      const initRes = await fetch("/api/orders/init", { method: "POST" });
      const initData = await initRes.json() as { success: boolean; error?: string };
      if (!initData.success && initRes.status !== 200) {
        setError(initData.error ?? "初期化に失敗しました");
        return;
      }

      // 初期化完了後、自動でPOST /api/orders/refetchを再実行
      const refetchRes = await fetch("/api/orders/refetch", { method: "POST" });
      const refetchData = await refetchRes.json() as RefetchApiResponse;
      if (!refetchData.success || !refetchData.diff_result) {
        setError(refetchData.error ?? "再取得に失敗しました");
        return;
      }

      // モーダルの表示を新しい結果で更新
      setDiffResult(refetchData.diff_result);
    } catch {
      setError("ネットワークエラーが発生しました");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 p-6 flex flex-col gap-4">
        <h2 className="text-base font-semibold text-gray-900">再取得しました</h2>

        {/* パターン3：未初期化注文あり */}
        {has_new_uninitialized && (
          <>
            <p className="text-sm text-amber-700 bg-amber-50 rounded p-3">
              新しい未対応注文が <strong>{new_uninitialized_count} 件</strong> あります。
              アプリへの取り込み（初期化）が必要です。
            </p>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleInitAndRefetch}
              className="w-full py-2 rounded bg-blue-600 text-white text-sm font-medium
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? "処理中..." : "初期化を実行する"}
            </button>
          </>
        )}

        {/* パターン1：差分なし */}
        {!has_new_uninitialized && !has_diff && (
          <>
            <p className="text-sm text-green-700 bg-green-50 rounded p-3">
              差分はありません
            </p>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleConfirm}
              className="w-full py-2 rounded bg-blue-600 text-white text-sm font-medium
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? "処理中..." : "確認して出荷準備へ進む"}
            </button>
          </>
        )}

        {/* パターン2：差分あり */}
        {!has_new_uninitialized && has_diff && (
          <>
            <p className="text-sm text-gray-700">以下の差分があります</p>
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
              {diff_summary.map((item, i) => (
                <div
                  key={`${item.unique_key}-${i}`}
                  className={`text-xs px-3 py-2 rounded ${SEVERITY_CLASS[item.severity]}`}
                >
                  <span className="font-medium mr-2">[{SEVERITY_LABEL[item.severity]}]</span>
                  {item.description}
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleConfirm}
              className="w-full py-2 rounded bg-blue-600 text-white text-sm font-medium
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? "処理中..." : "内容を確認しました"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

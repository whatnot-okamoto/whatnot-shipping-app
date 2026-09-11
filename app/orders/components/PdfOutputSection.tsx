"use client";

import { useState } from "react";
import type { LockedBundleInfo } from "./LockedStageView";
import ReceiptNameWarningModal from "./ReceiptNameWarningModal";
import { usePaymentLabelWarning } from "@/app/_hooks/usePaymentLabelWarning";
import PaymentLabelWarningBanner from "@/app/_components/PaymentLabelWarningBanner";
import {
  buildBaseReviewGuidance,
  GENERATION_ISSUE_LABELS,
} from "@/lib/order-generation-messages";
import type {
  CancellationState,
  GenerationIssueCode,
} from "@/lib/pdf-order-assessment";

function extractFilenameFromContentDisposition(header: string | null): string {
  if (!header) return "whatnot-shipping.pdf";

  const filenameStarMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStarMatch) {
    try {
      return decodeURIComponent(filenameStarMatch[1].trim());
    } catch {
      // デコード失敗時は filename にフォールバック
    }
  }

  const filenameMatch = header.match(/filename="?([^";]+)"?/i);
  if (filenameMatch) {
    return filenameMatch[1].trim();
  }

  return "whatnot-shipping.pdf";
}

type Props = {
  pdfOutputDoneFlag: boolean;
  lockedBundles: LockedBundleInfo[];
  onSuccess: () => Promise<void>;
};

type BlockedOrder = {
  unique_key: string;
  cancellation_state: CancellationState;
  issues: GenerationIssueCode[];
};

type FailedOrder = {
  unique_key: string;
  reason: "base_order_fetch_failed";
};

type PdfFailure = {
  outcome: "blocked" | "retryable_error" | "fatal_error";
  message: string;
  blockedOrders: BlockedOrder[];
  failedOrders: FailedOrder[];
};

export default function PdfOutputSection({
  pdfOutputDoneFlag,
  lockedBundles,
  onSuccess,
}: Props) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [failure, setFailure] = useState<PdfFailure | null>(null);
  const [showWarning, setShowWarning] = useState(false);
  const { paymentWarning, parsePaymentWarning } = usePaymentLabelWarning();

  // receipt_required===true かつ receipt_name が空の注文が1件以上あるか
  const hasEmptyReceiptName = lockedBundles.some(
    (b) => b.receipt_required && b.receipt_name_empty
  );

  const handleButtonClick = () => {
    setFailure(null);
    if (hasEmptyReceiptName) {
      setShowWarning(true);
    } else {
      void handleGenerate();
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setFailure(null);
    try {
      const res = await fetch("/api/pdf/generate", { method: "POST" });

      if (!res.ok) {
        const data = (await res.json()) as {
          outcome?: PdfFailure["outcome"];
          error?: string;
          blocked_orders?: BlockedOrder[];
          failed_orders?: FailedOrder[];
        };
        setFailure({
          outcome:
            data.outcome === "blocked" || data.outcome === "retryable_error"
              ? data.outcome
              : "fatal_error",
          message: data.error ?? "PDF生成に失敗しました。",
          blockedOrders: data.blocked_orders ?? [],
          failedOrders: data.failed_orders ?? [],
        });
        return;
      }

      // PAYMENT-LABEL-UNKNOWN-01 警告 header の解析（共有 hook）
      parsePaymentWarning(res);

      // blobとして受け取りブラウザダウンロードを実行
      const contentDisposition = res.headers.get("Content-Disposition");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = extractFilenameFromContentDisposition(contentDisposition);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      await onSuccess();
    } catch {
      setFailure({
        outcome: "retryable_error",
        message: "PDF生成中に通信エラーが発生しました。",
        blockedOrders: [],
        failedOrders: [],
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const affectedUniqueKeys = new Set([
    ...(failure?.blockedOrders.map((order) => order.unique_key) ?? []),
    ...(failure?.failedOrders.map((order) => order.unique_key) ?? []),
  ]);
  const affectedBundles = lockedBundles.filter((bundle) =>
    bundle.order_ids.some((uniqueKey) => affectedUniqueKeys.has(uniqueKey))
  );

  return (
    <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
      {failure && (
        <div
          className="mb-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
        >
          <p className="font-semibold">{failure.message}</p>

          {failure.failedOrders.length > 0 && (
            <div className="mt-3">
              <p className="font-medium">BASE注文詳細を取得できなかった注文</p>
              <ul className="mt-1 list-disc pl-5">
                {failure.failedOrders.map((order) => (
                  <li key={order.unique_key} className="break-all">
                    BASE注文ID：{order.unique_key}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {failure.blockedOrders.map((order) => (
            <div key={order.unique_key} className="mt-3 rounded border border-red-200 bg-white p-3">
              <p className="break-all font-medium">BASE注文ID：{order.unique_key}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {order.issues.map((issue) => (
                  <li key={issue}>{GENERATION_ISSUE_LABELS[issue]}</li>
                ))}
              </ul>
              <p className="mt-2">{buildBaseReviewGuidance(order.issues)}</p>
            </div>
          ))}

          {affectedBundles.length > 0 && (
            <p className="mt-3 break-all">
              影響する配送グループ：
              {affectedBundles.map((bundle) => bundle.bundle_group_id).join("、")}
            </p>
          )}

          {failure.outcome === "retryable_error" && (
            <p className="mt-3">
              緊急セッション解除は不要です。現在のセッションを維持したまま、通信状態を確認してこのボタンから再試行してください。
            </p>
          )}
          {failure.outcome === "blocked" && (
            <div className="mt-3 space-y-2">
              <p>
                現在はロック中のため、問題注文を対象から外して正常な別U2だけを続けるには、画面下部の「緊急セッション解除」が必要です。同じU2内の注文だけを切り離すことはできません。
              </p>
              <p>
                BASEで各注文の状態を確認後、問題のあるU2を選択から外して新しいセッションを開始してください。緊急解除時のCSV状態は旧セッションに保持され、新しいセッションでは初期化されます。
              </p>
              <p>
                すでに取り込んだCSV、印刷済み送り状、発行済みPDFは取り消されません。重複取込・重複発行がないか確認してから再開してください。
              </p>
            </div>
          )}
          {failure.outcome === "fatal_error" && (
            <p className="mt-3">
              再試行しても続く場合は管理者へ確認してください。セッション解除は、注文を外して別U2を継続する必要がある場合だけ行ってください。
            </p>
          )}
        </div>
      )}

      <PaymentLabelWarningBanner warning={paymentWarning} withMargin />

      {!pdfOutputDoneFlag ? (
        // 初回出力ボタン
        <button
          type="button"
          disabled={isGenerating}
          onClick={handleButtonClick}
          className="w-full py-2.5 text-sm font-medium rounded
                     bg-blue-600 text-white hover:bg-blue-700
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isGenerating ? "PDF生成中..." : "納品書・領収書を出力する"}
        </button>
      ) : (
        // 出力済みバッジ + S2案内テキスト + 再出力ボタン
        <>
          <div className="flex items-center gap-3 mb-3">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              PDF出力済み
            </span>
          </div>
          <p className="text-sm text-gray-600 mb-4 leading-relaxed">
            PDF出力が完了しました。<br />
            印刷後、内容（配送業者・商品・個口数など）を確認してください。<br />
            CSV出力は次Stepで実装予定です。
          </p>
          <button
            type="button"
            disabled={isGenerating}
            onClick={handleButtonClick}
            className="text-sm text-blue-600 underline
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? "PDF生成中..." : "再出力する"}
          </button>
        </>
      )}

      {showWarning && (
        <ReceiptNameWarningModal
          onContinue={() => {
            setShowWarning(false);
            void handleGenerate();
          }}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </div>
  );
}

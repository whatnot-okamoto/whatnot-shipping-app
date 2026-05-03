"use client";

import { useState } from "react";
import type { LockedBundleInfo } from "./LockedStageView";
import ReceiptNameWarningModal from "./ReceiptNameWarningModal";

type Props = {
  pdfOutputDoneFlag: boolean;
  lockedBundles: LockedBundleInfo[];
  onSuccess: () => Promise<void>;
};

export default function PdfOutputSection({
  pdfOutputDoneFlag,
  lockedBundles,
  onSuccess,
}: Props) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWarning, setShowWarning] = useState(false);

  // receipt_required===true かつ receipt_name が空の注文が1件以上あるか
  const hasEmptyReceiptName = lockedBundles.some(
    (b) => b.receipt_required && b.receipt_name_empty
  );

  const handleButtonClick = () => {
    setError(null);
    if (hasEmptyReceiptName) {
      setShowWarning(true);
    } else {
      void handleGenerate();
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/pdf/generate", { method: "POST" });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "PDF生成に失敗しました。");
        return;
      }

      // blobとして受け取りブラウザダウンロードを実行
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "shipping-documents.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      await onSuccess();
    } catch {
      setError("PDF生成中にエラーが発生しました。");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
      {error && (
        <p className="mb-3 text-sm text-red-600">{error}</p>
      )}

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

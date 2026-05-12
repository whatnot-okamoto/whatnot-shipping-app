"use client";

// S3 CSV出力セクション（D-3A実装）
// ネコポス→佐川→ヤマトの順序固定（FLOW-01 R1準拠）
// pdf_output_done_flag=false 時は全ボタン非活性
// 順序制御: 前キャリアが done/skipped にならない限り次キャリアは非活性

import { useState } from "react";
import type { CsvStatusMap, CsvStatus } from "@/lib/session-store";

type CsvCarrier = "nekopos" | "sagawa" | "yamato";

type Props = {
  pdfOutputDoneFlag: boolean;
  csvStatus: CsvStatusMap;
  onCsvStatusChange: (carrier: CsvCarrier, status: CsvStatus) => void;
};

const CARRIER_LABELS: Record<CsvCarrier, string> = {
  nekopos: "ネコポス",
  sagawa: "佐川",
  yamato: "ヤマト宅急便",
};

const CARRIER_ORDER: CsvCarrier[] = ["nekopos", "sagawa", "yamato"];

function StatusBadge({ status }: { status: CsvStatus }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
        ✅ 出力済み
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
        — 対象なし
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        ⚠️ エラー（再実行可）
      </span>
    );
  }
  return null;
}

function isCarrierEnabled(
  carrier: CsvCarrier,
  pdfOutputDoneFlag: boolean,
  csvStatus: CsvStatusMap
): boolean {
  if (!pdfOutputDoneFlag) return false;
  if (carrier === "nekopos") return true;
  if (carrier === "sagawa") {
    return csvStatus.nekopos === "done" || csvStatus.nekopos === "skipped";
  }
  // yamato
  return csvStatus.sagawa === "done" || csvStatus.sagawa === "skipped";
}

export default function CsvOutputSection({
  pdfOutputDoneFlag,
  csvStatus,
  onCsvStatusChange,
}: Props) {
  const [loadingCarrier, setLoadingCarrier] = useState<CsvCarrier | null>(null);
  const [errorMessages, setErrorMessages] = useState<
    Partial<Record<CsvCarrier, string>>
  >({});

  const handleCsvOutput = async (carrier: CsvCarrier) => {
    setLoadingCarrier(carrier);
    setErrorMessages((prev) => ({ ...prev, [carrier]: undefined }));

    try {
      const res = await fetch("/api/csv/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrier }),
      });

      if (res.ok) {
        const contentType = res.headers.get("Content-Type") ?? "";

        if (contentType.includes("application/json")) {
          // skipped ケース
          const data = (await res.json()) as { status: string; carrier: string };
          if (data.status === "skipped") {
            onCsvStatusChange(carrier, "skipped");
          }
        } else {
          // done ケース: CSV ファイルをダウンロード
          const blob = await res.blob();
          const disposition = res.headers.get("Content-Disposition") ?? "";
          const filenameMatch = disposition.match(/filename="([^"]+)"/);
          const filename = filenameMatch
            ? filenameMatch[1]
            : `${carrier}_${Date.now()}.csv`;

          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          onCsvStatusChange(carrier, "done");
        }
      } else {
        const data = (await res.json()) as { status: string; message?: string };
        const message =
          data.message ?? "CSV生成中にエラーが発生しました。再試行してください。";
        setErrorMessages((prev) => ({ ...prev, [carrier]: message }));
        onCsvStatusChange(carrier, "error");
      }
    } catch {
      const message = "ネットワークエラーが発生しました。再試行してください。";
      setErrorMessages((prev) => ({ ...prev, [carrier]: message }));
      onCsvStatusChange(carrier, "error");
    } finally {
      setLoadingCarrier(null);
    }
  };

  return (
    <div className="mt-4 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
      <h3 className="text-sm font-medium text-gray-700 mb-3">CSV出力（S3）</h3>

      {!pdfOutputDoneFlag && (
        <p className="text-xs text-gray-400 mb-3">
          PDF出力（S1）が完了するとCSV出力が可能になります。
        </p>
      )}

      <div className="flex flex-col gap-3">
        {CARRIER_ORDER.map((carrier) => {
          const status = csvStatus[carrier];
          const enabled = isCarrierEnabled(carrier, pdfOutputDoneFlag, csvStatus);
          const isLoading = loadingCarrier === carrier;
          const isDoneOrSkipped = status === "done" || status === "skipped";
          const errorMsg = errorMessages[carrier];
          const label = CARRIER_LABELS[carrier];

          return (
            <div key={carrier} className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={!enabled || isLoading}
                  onClick={() => void handleCsvOutput(carrier)}
                  className={[
                    "flex-1 py-2 text-sm font-medium rounded border transition-colors",
                    enabled && !isLoading
                      ? isDoneOrSkipped
                        ? "border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100"
                        : "border-blue-500 bg-white text-blue-600 hover:bg-blue-50"
                      : "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isLoading
                    ? `${label} CSV生成中...`
                    : isDoneOrSkipped
                    ? `${label} CSV（再出力）`
                    : `${label} CSV出力`}
                </button>

                <StatusBadge status={status} />
              </div>

              {errorMsg && (
                <p className="text-xs text-red-600 leading-relaxed">{errorMsg}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

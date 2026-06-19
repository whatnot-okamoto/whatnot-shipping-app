"use client";

// PAYMENT-LABEL-UNKNOWN-01 区分2
// 未知決済ラベル警告バナー（プレゼンのみ）。
// 文言・スタイルクラスは既存2画面と一致。
// 外側 margin（mb-3）は props で切替: PdfOutputSection は付与・pdf-fixture は非付与。
// client 部品: server 専用 import を一切持たない。

import type { PaymentLabelWarning } from "@/app/_lib/paymentLabelWarning";

type Props = {
  warning: PaymentLabelWarning | null;
  withMargin?: boolean;
};

export default function PaymentLabelWarningBanner({
  warning,
  withMargin = false,
}: Props) {
  if (!warning) return null;

  const className = `${withMargin ? "mb-3 " : ""}p-3 bg-yellow-50 border border-yellow-400 rounded text-sm text-yellow-800`;

  return (
    <div className={className}>
      未対応の支払い方法（{warning.values.join("、")}）が {warning.affectedCount} 件の注文に含まれています。PDF の決済方法表示をご確認のうえ、PAYMENT_LABELS への追加マッピング検討をお願いします。金額・税額計算には影響しません。
    </div>
  );
}

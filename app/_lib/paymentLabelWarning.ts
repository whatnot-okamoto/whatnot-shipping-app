// PAYMENT-LABEL-UNKNOWN-01 区分2
// 未知決済ラベル警告の共有型と純粋解析関数。
// 中立ファイル: "use client" も server 専用 import も持たない。
// fetch・ネットワーク処理を持たない。X-Payment-Label-Unknown ヘッダー値の解析のみ。

export type PaymentLabelWarning = {
  values: string[]; // UI 表示用: 空値は "（空値）" へ変換済み
  affectedCount: number;
};

// X-Payment-Label-Unknown のヘッダー値（文字列）を解析する純粋関数。
// decodeURIComponent → JSON.parse → __empty__ を「（空値）」へ変換 → PaymentLabelWarning または null。
// header が null・空・解析失敗時は呼び出し側（hook）で catch する。
export function parsePaymentLabelWarning(
  raw: string | null
): PaymentLabelWarning | null {
  if (!raw) return null;

  const decoded = decodeURIComponent(raw);
  const parsed = JSON.parse(decoded) as {
    values: string[];
    affectedCount: number;
  };
  const uiValues = parsed.values.map((v) =>
    v === "__empty__" ? "（空値）" : v
  );
  return { values: uiValues, affectedCount: parsed.affectedCount };
}

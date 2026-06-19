"use client";

// PAYMENT-LABEL-UNKNOWN-01 区分2
// 未知決済ラベル警告の共有 hook。
// paymentWarning state を保持し、Response / Headers / ヘッダー値を受け取って解析・state 更新する。
// hook は fetch を実行しない（解析のみ）。
// D3: 解析失敗（catch）時は警告を null へクリアし、古い警告を残さない。

import { useCallback, useState } from "react";
import {
  parsePaymentLabelWarning,
  type PaymentLabelWarning,
} from "@/app/_lib/paymentLabelWarning";

type HeaderSource = Response | Headers | string | null;

function extractRawHeader(source: HeaderSource): string | null {
  if (source === null) return null;
  if (typeof source === "string") return source;
  // Response は headers プロパティを持つ。Headers は get を直接持つ。
  const headers = source instanceof Response ? source.headers : source;
  return headers.get("X-Payment-Label-Unknown");
}

export function usePaymentLabelWarning() {
  const [paymentWarning, setPaymentWarning] =
    useState<PaymentLabelWarning | null>(null);

  // Response / Headers / ヘッダー値を受け取って解析し、state を更新する。
  // 解析失敗時は警告を null クリアする（D3）。
  const parsePaymentWarning = useCallback((source: HeaderSource) => {
    try {
      const raw = extractRawHeader(source);
      setPaymentWarning(parsePaymentLabelWarning(raw));
    } catch (e) {
      console.warn("Payment label warning header parse error", e);
      setPaymentWarning(null);
    }
  }, []);

  const reset = useCallback(() => {
    setPaymentWarning(null);
  }, []);

  return { paymentWarning, parsePaymentWarning, reset };
}

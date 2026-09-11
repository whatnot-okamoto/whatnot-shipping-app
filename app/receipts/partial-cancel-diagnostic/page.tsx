"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppNavigation from "@/app/_components/AppNavigation";
import {
  AMOUNT_PATH_KEYS,
  FORMULA_RELATION_KEYS,
  type PartialCancelDiagnostic,
} from "@/lib/partial-cancel-diagnostic-v2";
import { readSafePartialCancelDiagnostic } from "@/lib/partial-cancel-diagnostic-ui";

const ENDPOINT = "/api/receipts/partial-cancel-diagnostic";
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type PreflightState = "checking" | "ready" | "failed";

export default function PartialCancelDiagnosticPage() {
  const router = useRouter();
  const orderIdRef = useRef<HTMLInputElement>(null);
  const preflightStartedRef = useRef(false);
  const [preflight, setPreflight] = useState<PreflightState>("checking");
  const [used, setUsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [diagnostic, setDiagnostic] = useState<PartialCancelDiagnostic | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (preflightStartedRef.current) return;
    preflightStartedRef.current = true;
    const controller = new AbortController();

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 400) {
          setPreflight("ready");
          return;
        }
        setPreflight("failed");
        setMessage("安全確認を完了できませんでした。この画面からは実行できません。");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPreflight("failed");
        setMessage("安全確認の通信を完了できませんでした。この画面からは実行できません。");
      });

    return () => controller.abort();
  }, [router]);

  const submitDiagnostic = async (event: React.FormEvent) => {
    event.preventDefault();
    if (preflight !== "ready" || used || submitting) return;

    const input = orderIdRef.current;
    const uniqueKey = input?.value.trim() ?? "";
    if (!ORDER_ID_PATTERN.test(uniqueKey)) {
      setMessage("注文IDの入力内容を確認してください。");
      return;
    }

    if (input) input.value = "";
    setUsed(true);
    setSubmitting(true);
    setMessage(null);
    setDiagnostic(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unique_key: uniqueKey }),
        cache: "no-store",
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      if (!response.ok) {
        setMessage("診断を完了できませんでした。再実行せず、状態を確認してください。");
        return;
      }

      const safeDiagnostic = readSafePartialCancelDiagnostic(await response.json());
      if (!safeDiagnostic) {
        setMessage("安全に表示できる診断結果ではありません。再実行しないでください。");
        return;
      }
      setDiagnostic(safeDiagnostic);
    } catch {
      setMessage("診断結果を受け取れませんでした。再実行しないでください。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <AppNavigation />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-2xl font-bold">一部キャンセル構造診断</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          対象注文を1回だけ読み取り、実値を表示せず構造上の判定だけを確認します。
        </p>

        <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">接続前の安全確認</h2>
          <p className="mt-2 text-sm text-gray-700" role="status">
            {preflight === "checking" && "認証済みの診断経路を確認しています…"}
            {preflight === "ready" && "確認完了。注文IDを入力できます。"}
            {preflight === "failed" && "確認失敗。実注文診断は無効です。"}
          </p>
        </section>

        <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <form onSubmit={submitDiagnostic}>
            <label htmlFor="diagnostic-order-id" className="block text-sm font-medium text-gray-700">
              BASE注文ID
            </label>
            <input
              ref={orderIdRef}
              id="diagnostic-order-id"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={preflight !== "ready" || used || submitting}
              className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
            />
            <p className="mt-2 text-xs leading-5 text-gray-500">
              入力値は画面・URL・結果には表示せず、送信開始時に入力欄から消去します。
            </p>
            <button
              type="submit"
              disabled={preflight !== "ready" || used || submitting}
              className="mt-4 w-full rounded-md bg-red-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {submitting ? "1回だけ診断中…" : used ? "この画面では実行済み" : "1回だけ診断する"}
            </button>
          </form>
        </section>

        {message && (
          <div role="alert" className="mt-5 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            {message}
          </div>
        )}

        {diagnostic && (
          <section className="mt-5 rounded-lg border border-green-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold">診断結果（実値なし）</h2>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <Result label="結果" value={diagnostic.outcome} />
              <Result label="キャンセル候補" value={diagnostic.cancellationCandidate} />
              <Result label="status整合" value={diagnostic.cancellationConsistency} />
              <Result label="キャンセル商品残存" value={diagnostic.cancelledItemsRemainInOrderItems} />
              <Result label="top-level cancelled" value={diagnostic.topLevelCancelled} />
              <Result label="未知status" value={diagnostic.unknownItemStatus} />
              <Result label="ordered" value={diagnostic.knownItemStatuses.ordered} />
              <Result label="cancelled" value={diagnostic.knownItemStatuses.cancelled} />
              <Result label="dispatched" value={diagnostic.knownItemStatuses.dispatched} />
              <Result label="有効商品の税率" value={diagnostic.taxRateComposition.active} />
              <Result label="キャンセル商品の税率" value={diagnostic.taxRateComposition.cancelled} />
              <Result label="送料対象" value={diagnostic.shippingLineItemScope} />
              <Result label="割引" value={diagnostic.adjustmentPresence.discount} />
              <Result label="コイン割引" value={diagnostic.adjustmentPresence.coinDiscount} />
              <Result label="調整額" value={diagnostic.adjustmentPresence.adjustment} />
              <Result label="代引手数料" value={diagnostic.adjustmentPresence.codFee} />
            </dl>

            <h3 className="mt-6 text-sm font-semibold">金額経路の存在関係</h3>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              {AMOUNT_PATH_KEYS.flatMap((key) => [
                <Result key={`active-${key}`} label={`有効商品 ${key}`} value={diagnostic.amountPathPresence.active[key]} />,
                <Result key={`cancelled-${key}`} label={`キャンセル商品 ${key}`} value={diagnostic.amountPathPresence.cancelled[key]} />,
              ])}
              <Result label="有効商品の経路一致" value={diagnostic.amountPathAgreement.active} />
              <Result label="キャンセル商品の経路一致" value={diagnostic.amountPathAgreement.cancelled} />
            </dl>

            <h3 className="mt-6 text-sm font-semibold">totalとの式比較</h3>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              {FORMULA_RELATION_KEYS.map((key) => (
                <Result key={key} label={key} value={diagnostic.formulaRelations[key]} />
              ))}
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-gray-50 px-3 py-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs text-gray-900">{value}</dd>
    </div>
  );
}

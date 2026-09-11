"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppNavigation from "@/app/_components/AppNavigation";
import {
  MAX_RECEIPT_NAME_LENGTH,
  MAX_RECEIPT_NOTE_LENGTH,
} from "@/lib/receipt-share-constants";
import {
  buildBaseReviewGuidance,
  GENERATION_ISSUE_LABELS,
} from "@/lib/order-generation-messages";
import type {
  CancellationState,
  GenerationIssueCode,
} from "@/lib/pdf-order-assessment";

type ReceiptOrderSummary = {
  unique_key: string;
  purchaserName: string;
  ordered: number;
  dispatched: number | null;
  cancelled: number | null;
  dispatchStatus: string;
  paymentCode: string;
  paymentLabel: string;
  total: number;
  warnings: string[];
  hasUnknownPayment: boolean;
  cancellationState: CancellationState;
  generationOutcome: "eligible" | "blocked";
  issues: GenerationIssueCode[];
};

type ShareResult = {
  shareUrl: string;
  expiresAt: number;
};

function formatDateTime(unixSeconds: number | null): string {
  if (unixSeconds === null) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(unixSeconds * 1000));
}

function formatExpiry(timestampMs: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestampMs));
}

function dispatchStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    unshippable: "対応開始前",
    ordered: "未対応",
    cancelled: "キャンセル",
    dispatched: "対応済み・発送済み",
    unpaid: "入金待ち",
    shipping: "配送中",
  };
  return labels[status] ?? status;
}

function cancellationStateLabel(state: CancellationState): string {
  const labels: Record<CancellationState, string> = {
    normal: "通常注文",
    partial_cancel: "一部キャンセル（有効商品のみ帳票へ反映）",
    full_cancel: "全商品キャンセル",
    cancellation_state_unknown: "判定不能",
  };
  return labels[state];
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

export default function ReceiptsPage() {
  const router = useRouter();
  const [uniqueKey, setUniqueKey] = useState("");
  const [order, setOrder] = useState<ReceiptOrderSummary | null>(null);
  const [receiptName, setReceiptName] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [share, setShare] = useState<ShareResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRequestRef = useRef<{
    controller: AbortController;
    shareUrl: string;
  } | null>(null);

  useEffect(() => {
    return () => {
      const activeRequest = previewRequestRef.current;
      previewRequestRef.current = null;
      activeRequest?.controller.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const resetShareConfirmation = () => {
    previewRequestRef.current?.controller.abort();
    previewRequestRef.current = null;
    setShare(null);
    setPreviewUrl(null);
    setLoadingPreview(false);
    setPreviewOpened(false);
    setConfirmed(false);
    setCopied(false);
  };

  const handleUniqueKeyChange = (value: string) => {
    setUniqueKey(value);
    setOrder(null);
    setReceiptName("");
    setReceiptNote("");
    setError(null);
    resetShareConfirmation();
  };

  const handleReceiptNameChange = (value: string) => {
    setReceiptName(
      Array.from(value).slice(0, MAX_RECEIPT_NAME_LENGTH).join("")
    );
    setError(null);
    resetShareConfirmation();
  };

  const handleReceiptNoteChange = (value: string) => {
    setReceiptNote(
      Array.from(value).slice(0, MAX_RECEIPT_NOTE_LENGTH).join("")
    );
    setError(null);
    resetShareConfirmation();
  };

  const handleUnauthorized = (status: number): boolean => {
    if (status !== 401) return false;
    router.replace("/login");
    return true;
  };

  const readError = async (res: Response, fallback: string) => {
    try {
      const data = (await res.json()) as { error?: string };
      return data.error ?? fallback;
    } catch {
      return fallback;
    }
  };

  const lookupOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUniqueKey = uniqueKey.trim();
    if (!trimmedUniqueKey) {
      setError("BASE注文IDを入力してください。");
      return;
    }

    setLoadingOrder(true);
    setError(null);
    setOrder(null);
    resetShareConfirmation();

    try {
      const res = await fetch("/api/receipts/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unique_key: trimmedUniqueKey }),
      });
      if (handleUnauthorized(res.status)) return;
      if (!res.ok) {
        setError(await readError(res, "注文情報を取得できませんでした。"));
        return;
      }

      const data = (await res.json()) as { order: ReceiptOrderSummary };
      setUniqueKey(data.order.unique_key);
      setOrder(data.order);
    } catch {
      setError("通信エラーが発生しました。再試行してください。");
    } finally {
      setLoadingOrder(false);
    }
  };

  const createShareUrl = async () => {
    if (!order || order.generationOutcome === "blocked") return;

    setCreatingShare(true);
    setError(null);
    resetShareConfirmation();

    try {
      const res = await fetch("/api/receipts/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unique_key: order.unique_key,
          receipt_name: receiptName,
          receipt_note: receiptNote,
        }),
      });
      if (handleUnauthorized(res.status)) return;
      if (!res.ok) {
        setError(await readError(res, "共有URLを作成できませんでした。"));
        return;
      }

      const data = (await res.json()) as {
        share_url: string;
        expires_at: number;
        order: ReceiptOrderSummary;
      };
      setOrder(data.order);
      setShare({ shareUrl: data.share_url, expiresAt: data.expires_at });
    } catch {
      setError("通信エラーが発生しました。再試行してください。");
    } finally {
      setCreatingShare(false);
    }
  };

  const loadPreview = async () => {
    if (!share) return;

    previewRequestRef.current?.controller.abort();
    const request = {
      controller: new AbortController(),
      shareUrl: share.shareUrl,
    };
    previewRequestRef.current = request;
    setLoadingPreview(true);
    setPreviewUrl(null);
    setPreviewOpened(false);
    setConfirmed(false);
    setCopied(false);

    try {
      const res = await fetch(request.shareUrl, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!res.ok || !res.headers.get("Content-Type")?.startsWith("application/pdf")) {
        if (previewRequestRef.current !== request) return;
        setError("領収書PDFを読み込めませんでした。URLを作り直してください。");
        return;
      }
      const pdfBlob = await res.blob();
      if (previewRequestRef.current !== request) return;
      setPreviewUrl(URL.createObjectURL(pdfBlob));
      setError(null);
    } catch (error) {
      if (previewRequestRef.current !== request) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError("領収書PDFを読み込めませんでした。再試行してください。");
    } finally {
      if (previewRequestRef.current === request) {
        previewRequestRef.current = null;
        setLoadingPreview(false);
      }
    }
  };

  const copyShareUrl = async () => {
    if (!share || !confirmed) return;
    try {
      await copyToClipboard(share.shareUrl);
      setCopied(true);
      setError(null);
    } catch {
      setCopied(false);
      setError("URLをコピーできませんでした。ブラウザの設定を確認してください。");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <AppNavigation />

      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">領収書発行</h1>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            お客様へ共有する30日間有効な領収書URLを作成します。PDFと発行履歴は保存されません。
          </p>
        </div>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">1. 注文を確認</h2>
          <form onSubmit={lookupOrder} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <label
                htmlFor="unique-key"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                BASE注文ID
              </label>
              <input
                id="unique-key"
                type="text"
                value={uniqueKey}
                onChange={(e) => handleUniqueKeyChange(e.target.value)}
                autoComplete="off"
                disabled={loadingOrder || creatingShare}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100"
              />
            </div>
            <button
              type="submit"
              disabled={loadingOrder || creatingShare}
              className="self-end rounded-md bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {loadingOrder ? "確認中..." : "注文情報を確認"}
            </button>
          </form>
        </section>

        {order && (
          <>
            <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold">注文概要</h2>

              {order.generationOutcome === "blocked" && (
                <div
                  className="mt-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
                  role="alert"
                >
                  <p className="font-semibold">この注文はアプリで領収書を発行できません。</p>
                  <p className="mt-2 break-all">対象のBASE注文ID：{order.unique_key}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {order.issues.map((issue) => (
                      <li key={issue}>{GENERATION_ISSUE_LABELS[issue]}</li>
                    ))}
                  </ul>
                  <p className="mt-3">{buildBaseReviewGuidance(order.issues)}</p>
                  <p className="mt-2">
                    この領収書専用画面は出荷セッションと無関係なため、緊急解除は不要です。
                    BASEを確認した後、この画面で注文情報を再取得してください。再取得しても続く場合は管理者へ確認してください。
                  </p>
                </div>
              )}

              {order.warnings.length > 0 && (
                <div className="mt-4 space-y-2" role="alert">
                  {order.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    >
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              {order.hasUnknownPayment && (
                <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  未登録の決済方法です。PDFに表示される決済方法を確認してください。
                </p>
              )}

              <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-gray-500">注文ID</dt>
                  <dd className="mt-1 break-all font-medium">{order.unique_key}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">購入者名</dt>
                  <dd className="mt-1 font-medium">{order.purchaserName}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">注文日時</dt>
                  <dd className="mt-1">{formatDateTime(order.ordered)}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">発送日時</dt>
                  <dd className="mt-1">{formatDateTime(order.dispatched)}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">注文状態</dt>
                  <dd className="mt-1">{dispatchStatusLabel(order.dispatchStatus)}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">BASEキャンセル情報</dt>
                  <dd className="mt-1">{cancellationStateLabel(order.cancellationState)}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">決済方法</dt>
                  <dd className="mt-1">{order.paymentLabel || order.paymentCode}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">合計金額</dt>
                  <dd className="mt-1 font-semibold">
                    {order.total.toLocaleString("ja-JP")}円
                  </dd>
                </div>
              </dl>
            </section>

            <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold">2. 領収書の内容を入力</h2>
              <p className="mt-2 text-sm text-gray-600">
                宛名・但し書きは空欄でも発行できます。入力した文字は自動変換しません。
              </p>

              <div className="mt-4 space-y-4">
                <div>
                  <label
                    htmlFor="receipt-name"
                    className="mb-1 block text-sm font-medium text-gray-700"
                  >
                    宛名
                  </label>
                  <input
                    id="receipt-name"
                    type="text"
                    value={receiptName}
                    onChange={(e) => handleReceiptNameChange(e.target.value)}
                    disabled={creatingShare || order.generationOutcome === "blocked"}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100"
                  />
                  <p className="mt-1 text-right text-xs text-gray-500">
                    {Array.from(receiptName).length}/{MAX_RECEIPT_NAME_LENGTH}文字
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="receipt-note"
                    className="mb-1 block text-sm font-medium text-gray-700"
                  >
                    但し書き
                  </label>
                  <input
                    id="receipt-note"
                    type="text"
                    value={receiptNote}
                    onChange={(e) => handleReceiptNoteChange(e.target.value)}
                    disabled={creatingShare || order.generationOutcome === "blocked"}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100"
                  />
                  <p className="mt-1 text-right text-xs text-gray-500">
                    {Array.from(receiptNote).length}/{MAX_RECEIPT_NOTE_LENGTH}文字
                  </p>
                </div>

                <button
                  type="button"
                  onClick={createShareUrl}
                  disabled={creatingShare || order.generationOutcome === "blocked"}
                  className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                >
                  {creatingShare ? "URL作成中..." : "共有URLを作成する"}
                </button>
              </div>
            </section>
          </>
        )}

        {share && (
          <section className="mt-5 rounded-lg border border-blue-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold">3. PDFを確認してURLをコピー</h2>
            <p className="mt-2 text-sm text-gray-600">
              有効期限：{formatExpiry(share.expiresAt)}（日本時間）
            </p>

            <button
              type="button"
              onClick={loadPreview}
              disabled={loadingPreview}
              className="mt-4 block w-full rounded-md border border-blue-600 px-4 py-2.5 text-center text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400"
            >
              {loadingPreview ? "領収書PDFを読み込み中..." : "領収書PDFを読み込む"}
            </button>

            {previewUrl && (
              <div className="mt-4 overflow-hidden rounded-md border border-gray-300 bg-gray-100">
                <iframe
                  title="確認用領収書PDF"
                  src={previewUrl}
                  onLoad={() => setPreviewOpened(true)}
                  className="h-[70vh] min-h-[560px] w-full"
                />
              </div>
            )}

            <label
              className={`mt-4 flex items-start gap-3 rounded-md border p-3 text-sm ${
                previewOpened
                  ? "cursor-pointer border-gray-300 bg-white"
                  : "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
              }`}
            >
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                  setCopied(false);
                }}
                disabled={!previewOpened}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                注文ID・宛名・但し書き・金額を確認しました
              </span>
            </label>

            <button
              type="button"
              onClick={copyShareUrl}
              disabled={!confirmed}
              className="mt-4 w-full rounded-md bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {copied ? "共有URLをコピーしました" : "共有URLをコピー"}
            </button>

            <p className="mt-3 text-xs leading-5 text-gray-500">
              URLを作り直しても、以前のURLはそれぞれの有効期限まで利用できます。
            </p>
          </section>
        )}

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        )}
      </main>
    </div>
  );
}

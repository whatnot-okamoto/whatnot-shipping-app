import { createElement, type ReactElement } from "react";
import {
  GENERATION_ISSUE_LABELS,
  buildBaseReviewGuidance,
} from "@/lib/order-generation-messages";
import type { GenerationIssueCode } from "@/lib/pdf-order-assessment";

type BlockedOrderResponse = {
  unique_key?: unknown;
  reason?: unknown;
  issues?: unknown;
};

export type SessionStartFailureOrder = {
  uniqueKey: string;
  reason: string;
  nextAction: string;
};

export type SessionStartFailure = {
  message: string;
  orders: SessionStartFailureOrder[];
};

function isIssueCode(value: unknown): value is GenerationIssueCode {
  return typeof value === "string" && Object.hasOwn(GENERATION_ISSUE_LABELS, value);
}

function describeBlockedOrder(raw: BlockedOrderResponse): SessionStartFailureOrder | null {
  if (typeof raw.unique_key !== "string" || raw.unique_key.length === 0) return null;
  const issues = Array.isArray(raw.issues) ? raw.issues.filter(isIssueCode) : [];

  switch (raw.reason) {
    case "fetch_failed":
      return {
        uniqueKey: raw.unique_key,
        reason: "今回の再取得で注文詳細を取得できませんでした。古い確認結果では開始できません。",
        nextAction: "再取得を実行し、差分確認後にもう一度選択してください。",
      };
    case "not_in_open_orders":
      return {
        uniqueKey: raw.unique_key,
        reason: GENERATION_ISSUE_LABELS.not_in_open_orders,
        nextAction: `${buildBaseReviewGuidance(["not_in_open_orders"])} 状態確認後、注文一覧を再取得してください。`,
      };
    case "blocked":
      return {
        uniqueKey: raw.unique_key,
        reason:
          issues.length > 0
            ? issues.map((issue) => GENERATION_ISSUE_LABELS[issue]).join(" ")
            : "注文内容をアプリで安全に自動処理できません。",
        nextAction: `${buildBaseReviewGuidance(issues)} 確認後に再取得してください。継続する場合は正常な別U2を選び直せます。`,
      };
    default:
      return {
        uniqueKey: raw.unique_key,
        reason: "今回の再取得サイクルで確認済みになっていません。",
        nextAction: "再取得と差分確認を完了してから選択し直してください。",
      };
  }
}

export function buildSessionStartFailure(data: unknown): SessionStartFailure | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as { error?: unknown; blocked_orders?: unknown };
  if (!Array.isArray(candidate.blocked_orders)) return null;
  const orders = candidate.blocked_orders
    .map((entry) =>
      entry && typeof entry === "object"
        ? describeBlockedOrder(entry as BlockedOrderResponse)
        : null
    )
    .filter((entry): entry is SessionStartFailureOrder => entry !== null);
  if (orders.length === 0) return null;
  return {
    message:
      typeof candidate.error === "string"
        ? candidate.error.replace(/^ORDER_NOT_ELIGIBLE:\s*/, "")
        : "アプリで処理できない注文が含まれています。",
    orders,
  };
}

type Props = {
  failure: SessionStartFailure;
  isRefetching: boolean;
  onRefetch: () => void;
  onClearSelection: () => void;
};

export default function SessionStartRecoveryPanel({
  failure,
  isRefetching,
  onRefetch,
  onClearSelection,
}: Props): ReactElement {
  return createElement(
    "section",
    {
      role: "alert",
      className: "mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950",
    },
    createElement("p", { className: "font-semibold" }, "出荷準備を開始できませんでした"),
    createElement("p", { className: "mt-1" }, failure.message),
    createElement(
      "div",
      { className: "mt-3 flex flex-col gap-2" },
      ...failure.orders.map((order) =>
        createElement(
          "div",
          { key: order.uniqueKey, className: "rounded border border-amber-200 bg-white p-3" },
          createElement("p", { className: "font-mono text-xs" }, `BASE注文ID：${order.uniqueKey}`),
          createElement("p", { className: "mt-1" }, `検出理由：${order.reason}`),
          createElement("p", { className: "mt-1" }, `次の操作：${order.nextAction}`)
        )
      )
    ),
    createElement(
      "div",
      { className: "mt-3 flex flex-wrap gap-2" },
      createElement(
        "button",
        {
          type: "button",
          disabled: isRefetching,
          onClick: onRefetch,
          className: "rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50",
        },
        isRefetching ? "再取得中..." : "再取得する"
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: onClearSelection,
          className: "rounded border border-gray-400 bg-white px-3 py-2 text-gray-700",
        },
        "選択を解除して注文一覧に戻る"
      )
    )
  );
}

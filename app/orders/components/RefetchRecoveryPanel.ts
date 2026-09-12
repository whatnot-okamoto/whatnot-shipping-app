import { createElement, type ReactElement } from "react";

export type RefetchFailure = {
  message: string;
  retryable: boolean;
};

export function buildRefetchFailure(data: unknown): RefetchFailure | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as {
    success?: unknown;
    error_type?: unknown;
    error?: unknown;
  };
  if (candidate.success !== false) return null;
  return {
    message:
      typeof candidate.error === "string" && candidate.error.length > 0
        ? candidate.error
        : "注文の再取得に失敗しました。注文一覧を維持したまま再試行してください。",
    retryable: candidate.error_type === "retryable_error",
  };
}

type Props = {
  failure: RefetchFailure;
  isRefetching: boolean;
  onRetry: () => void;
};

export default function RefetchRecoveryPanel({
  failure,
  isRefetching,
  onRetry,
}: Props): ReactElement {
  return createElement(
    "section",
    {
      role: "alert",
      className:
        "mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950",
    },
    createElement("p", { className: "font-semibold" }, "注文の再取得を完了できませんでした"),
    createElement("p", { className: "mt-1" }, failure.message),
    createElement(
      "p",
      { className: "mt-1" },
      "注文一覧と選択状態は維持されています。そのまま再取得できます。"
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: isRefetching,
        onClick: onRetry,
        className:
          "mt-3 rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50",
      },
      isRefetching ? "再取得中..." : "再取得する"
    )
  );
}

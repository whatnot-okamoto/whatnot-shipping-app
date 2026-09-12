import { createElement } from "react";
import type { DiffRecoveryStatus } from "./diff-confirm-view-policy";

type Props = {
  firstAbsenceCount: number;
  cycleNotInOpenOrdersCount: number;
  recoveryStatus?: DiffRecoveryStatus;
};

export default function DiffAbsenceSummary({
  firstAbsenceCount,
  cycleNotInOpenOrdersCount,
  recoveryStatus,
}: Props) {
  const showCycleTotal =
    recoveryStatus === "resuming_partial" || recoveryStatus === "conflict";
  if (recoveryStatus === "confirmed") return null;
  if (showCycleTotal && cycleNotInOpenOrdersCount <= 0) return null;
  if (!showCycleTotal && firstAbsenceCount <= 0) return null;

  return createElement(
    "div",
    { className: "text-sm text-gray-700 bg-gray-50 rounded p-3" },
    showCycleTotal
      ? createElement(
          "p",
          null,
          `今回cycleで不在判定となった総数：${cycleNotInOpenOrdersCount}件`
        )
      : createElement(
          "p",
          null,
          `今回初めて不在となった注文：${firstAbsenceCount}件`
        ),
    createElement(
      "p",
      { className: "mt-1" },
      showCycleTotal
        ? "旧処理の途中状態を復旧するため、今回cycleの総数を表示しています。"
        : "確認済みで不在が継続している注文は再掲せず、現在注文の出荷準備は継続できます。"
    )
  );
}

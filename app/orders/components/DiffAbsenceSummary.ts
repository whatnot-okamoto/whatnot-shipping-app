import { createElement } from "react";

type Props = {
  firstAbsenceCount: number;
  cycleNotInOpenOrdersCount: number;
};

export default function DiffAbsenceSummary({
  firstAbsenceCount,
  cycleNotInOpenOrdersCount,
}: Props) {
  if (firstAbsenceCount <= 0 && cycleNotInOpenOrdersCount <= 0) return null;

  return createElement(
    "div",
    { className: "text-sm text-gray-700 bg-gray-50 rounded p-3" },
    firstAbsenceCount > 0
      ? createElement(
          "p",
          null,
          `今回初めて不在となった注文：${firstAbsenceCount}件`
        )
      : null,
    createElement(
      "p",
      { className: firstAbsenceCount > 0 ? "mt-1" : undefined },
      `今回cycleで不在判定となった総数：${cycleNotInOpenOrdersCount}件`
    ),
    createElement(
      "p",
      { className: "mt-1" },
      "確認済みで不在が継続している注文は個別再掲せず、現在注文の出荷準備は継続できます。"
    )
  );
}

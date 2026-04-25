type Props = {
  needsInitialization: boolean;
  hasMultipleShippingLines: boolean;
  hasUnknownShippingMethod: boolean;
  cancelledFlag: boolean;
  holdFlag: boolean;
  shippingCategory: string;
  pickingStatus: "completed" | "in_progress" | "not_started";
};

type BadgeVariant = "orange" | "gray" | "yellow" | "green" | "blue" | "neutral";

function Badge({ variant, text }: { variant: BadgeVariant; text: string }) {
  const styles: Record<BadgeVariant, string> = {
    orange:  "bg-orange-100 text-orange-800",
    gray:    "bg-gray-200 text-gray-600",
    yellow:  "bg-yellow-100 text-yellow-800",
    green:   "bg-green-100 text-green-800",
    blue:    "bg-blue-100 text-blue-800",
    neutral: "bg-gray-50 text-gray-500 border border-gray-200",
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles[variant]}`}>
      {text}
    </span>
  );
}

export default function OrderStatusBadge({
  needsInitialization,
  hasMultipleShippingLines,
  hasUnknownShippingMethod,
  cancelledFlag,
  holdFlag,
  shippingCategory,
  pickingStatus,
}: Props) {
  if (needsInitialization) {
    return <Badge variant="orange" text="初期化必要" />;
  }
  if (hasMultipleShippingLines) {
    return <Badge variant="orange" text="配送ライン複数（C-5未確認）" />;
  }
  if (hasUnknownShippingMethod) {
    return <Badge variant="orange" text="配送方法不明" />;
  }
  if (cancelledFlag) {
    return <Badge variant="gray" text="キャンセル済み" />;
  }
  if (holdFlag) {
    return <Badge variant="yellow" text="保留中" />;
  }
  if (shippingCategory === "non-delivery") {
    return <Badge variant="gray" text="出荷対象外" />;
  }
  if (pickingStatus === "completed") {
    return <Badge variant="green" text="ピッキング完了" />;
  }
  if (pickingStatus === "in_progress") {
    return <Badge variant="blue" text="ピッキング中" />;
  }
  return <Badge variant="neutral" text="ピッキング未着手" />;
}

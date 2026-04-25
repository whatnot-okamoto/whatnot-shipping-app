type Props = {
  sessionStatus: "none" | "active" | "unlocked" | "completed";
  lockedBundleGroupIds: string[];
  refetchDoneFlag: boolean;
  diffConfirmedFlag: boolean;
};

export default function SessionStatusBar({
  sessionStatus,
  lockedBundleGroupIds,
  refetchDoneFlag,
  diffConfirmedFlag,
}: Props) {
  type StatusConfig = { text: string; barClass: string };

  const configs: Record<string, StatusConfig> = {
    none:      { text: "セッションなし",               barClass: "bg-gray-100 text-gray-600" },
    active:    { text: `セッション中：${lockedBundleGroupIds.length}件ロック中`, barClass: "bg-blue-50 text-blue-900 border-b-2 border-blue-400" },
    unlocked:  { text: "緊急解除済み：要確認",         barClass: "bg-red-50 text-red-900 border-b-2 border-red-400" },
    completed: { text: "セッション完了",               barClass: "bg-green-50 text-green-800" },
  };

  const { text, barClass } = configs[sessionStatus] ?? configs.none;

  const flagLabel = (label: string, done: boolean) => (
    <span
      className={`text-xs px-2 py-0.5 rounded ${
        done ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-500"
      }`}
    >
      {label}：{done ? "済" : "未"}
    </span>
  );

  return (
    <div className={`px-4 py-2 text-sm flex items-center gap-4 flex-wrap ${barClass}`}>
      <span className="font-semibold">{text}</span>
      {flagLabel("再取得", refetchDoneFlag)}
      {flagLabel("差分確認", diffConfirmedFlag)}
    </div>
  );
}

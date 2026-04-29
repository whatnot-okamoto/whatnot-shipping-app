// U2単位の表示カード（Step 4-B §10 LockedBundleGroupCard）
// 表示項目: bundle_group_id・代表注文ID・配下注文IDリスト・配送業者・受取人名・hold不整合警告・領収書有無

type Props = {
  bundle_group_id: string;
  /** 代表注文ID（実値は unique_key。ORDER-FIELD-01準拠） */
  representative_order_id: string;
  /** 配下注文IDリスト（実値は unique_key 配列。ORDER-FIELD-01準拠） */
  order_ids: string[];
  carrier: string;
  receiver_name: string;
  /** hold_flag === true の配下U1が存在する場合 true。原則 false（C6によりロック前に除外済み） */
  hold_flag_anomaly: boolean;
  /** 配下U1のいずれかに receipt_required === true がある場合 true */
  receipt_required: boolean;
};

const CARRIER_LABELS: Record<string, string> = {
  sagawa: "佐川急便",
  yamato: "ヤマト運輸",
  nekopos: "ネコポス",
};

export default function LockedBundleGroupCard({
  bundle_group_id,
  representative_order_id,
  order_ids,
  carrier,
  receiver_name,
  hold_flag_anomaly,
  receipt_required,
}: Props) {
  const bundleIdShort = bundle_group_id.slice(0, 11) + "...";
  const isBundled = order_ids.length > 1;

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm p-4">
      {/* ヘッダー行：受取人名・バッジ */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-gray-900 text-sm truncate">{receiver_name}</span>
          {isBundled && (
            <span className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded shrink-0">
              同梱{order_ids.length}件
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          {receipt_required && (
            <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded">
              領収書あり
            </span>
          )}
          <span className="text-xs bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">
            {(CARRIER_LABELS[carrier] ?? carrier) || "業者未定"}
          </span>
        </div>
      </div>

      {/* hold_flag 不整合警告（原則表示されない。C6により除外済みのため、表示はデータ不整合） */}
      {hold_flag_anomaly && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          ⚠ データ不整合：保留中の注文が含まれています（ロック条件検証の異常）
        </div>
      )}

      {/* 代表注文ID */}
      <div className="mt-2 text-xs text-gray-500">
        代表注文ID：
        <span className="font-mono text-gray-700">{representative_order_id}</span>
      </div>

      {/* 配下注文IDリスト（同梱の場合のみ表示） */}
      {isBundled && (
        <div className="mt-1 text-xs text-gray-400">
          配下：
          <span className="font-mono">{order_ids.join(", ")}</span>
        </div>
      )}

      {/* bundle_group_id（短縮表示） */}
      <div className="mt-1 text-xs text-gray-300 font-mono" title={bundle_group_id}>
        {bundleIdShort}
      </div>
    </div>
  );
}

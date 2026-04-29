"use client";

// ロック後ステージ最小UI（Step 4-B §10 UI-01準拠）
// U2単位を主表示とする。S1への説明文のみ表示し、ボタン類は一切設置しない。

import LockedBundleGroupCard from "./LockedBundleGroupCard";

export type LockedBundleInfo = {
  bundle_group_id: string;
  representative_order_id: string;
  order_ids: string[];
  carrier: string;
  receiver_name: string;
  hold_flag_anomaly: boolean;
  receipt_required: boolean;
};

type Props = {
  lockedBundles: LockedBundleInfo[];
};

export default function LockedStageView({ lockedBundles }: Props) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-4">
      {/* 概要行 */}
      <div className="mb-4 text-sm text-gray-700">
        <span className="font-medium">出荷準備中</span>
        <span className="ml-2 text-gray-500">
          {lockedBundles.length}件の配送グループ
        </span>
      </div>

      {/* U2単位カード一覧 */}
      <div className="flex flex-col gap-3">
        {lockedBundles.map((bundle) => (
          <LockedBundleGroupCard
            key={bundle.bundle_group_id}
            bundle_group_id={bundle.bundle_group_id}
            representative_order_id={bundle.representative_order_id}
            order_ids={bundle.order_ids}
            carrier={bundle.carrier}
            receiver_name={bundle.receiver_name}
            hold_flag_anomaly={bundle.hold_flag_anomaly}
            receipt_required={bundle.receipt_required}
          />
        ))}
      </div>

      {/* S1への導線（説明文のみ。ボタン・非活性ボタン・プレースホルダーは一切設置しない） */}
      <div className="mt-8 p-4 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-sm text-gray-500">
          次のステップ：納品書・領収書PDF出力（Step 4-Cで実装）
        </p>
      </div>
    </div>
  );
}

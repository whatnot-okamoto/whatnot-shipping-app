"use client";

// ロック後ステージ（Step 4-B §10 UI-01準拠・Step 4-C-2 PdfOutputSection組み込み）
// U2単位を主表示とする。PDF出力セクション（S2）を追加。

import LockedBundleGroupCard from "./LockedBundleGroupCard";
import PdfOutputSection from "./PdfOutputSection";

export type LockedBundleInfo = {
  bundle_group_id: string;
  representative_order_id: string;
  order_ids: string[];
  carrier: string;
  receiver_name: string;
  hold_flag_anomaly: boolean;
  receipt_required: boolean;
  /** receipt_required===true かつ receipt_name が空の場合 true（領収書宛名未入力警告用） */
  receipt_name_empty: boolean;
};

type Props = {
  lockedBundles: LockedBundleInfo[];
  pdfOutputDoneFlag: boolean;
  onRefreshSession: () => Promise<void>;
};

export default function LockedStageView({
  lockedBundles,
  pdfOutputDoneFlag,
  onRefreshSession,
}: Props) {
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

      {/* S2: PDF出力セクション（Step 4-C-2） */}
      <PdfOutputSection
        pdfOutputDoneFlag={pdfOutputDoneFlag}
        lockedBundles={lockedBundles}
        onSuccess={onRefreshSession}
      />
    </div>
  );
}

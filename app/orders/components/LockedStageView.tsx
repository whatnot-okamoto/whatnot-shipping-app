"use client";

// ロック後ステージ（Step 4-B §10 UI-01準拠・Step 4-C-2 PdfOutputSection組み込み）
// U2単位を主表示とする。PDF出力セクション（S1）・CSV出力セクション（S3）を追加。

import { useState } from "react";
import LockedBundleGroupCard from "./LockedBundleGroupCard";
import PdfOutputSection from "./PdfOutputSection";
import CsvOutputSection from "./CsvOutputSection";
import TrackingInputSection from "./TrackingInputSection";
import EmergencyUnlockModal from "./EmergencyUnlockModal";
import type { CsvStatusMap, CsvStatus } from "@/lib/session-store";

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
  /** U2 に保存済みの送り状番号。未入力の場合は "" */
  tracking_number: string;
};

type Props = {
  lockedBundles: LockedBundleInfo[];
  pdfOutputDoneFlag: boolean;
  csvStatus: CsvStatusMap;
  onRefreshSession: () => Promise<void>;
};

export default function LockedStageView({
  lockedBundles,
  pdfOutputDoneFlag,
  csvStatus,
  onRefreshSession,
}: Props) {
  // CsvOutputSection のステータスをローカルで保持（サーバー保存済み・表示即時反映用）
  const [localCsvStatus, setLocalCsvStatus] = useState<CsvStatusMap>(csvStatus);
  // SESSION-UNLOCK-UI-01 Phase 2: 緊急解除モーダルの開閉状態
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);

  const handleCsvStatusChange = (
    carrier: "nekopos" | "sagawa" | "yamato",
    status: CsvStatus
  ) => {
    setLocalCsvStatus((prev) => ({ ...prev, [carrier]: status }));
  };

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

      {/* S1: PDF出力セクション（Step 4-C-2） */}
      <PdfOutputSection
        pdfOutputDoneFlag={pdfOutputDoneFlag}
        lockedBundles={lockedBundles}
        onSuccess={onRefreshSession}
      />

      {/* S3: CSV出力セクション（D-3A） */}
      <CsvOutputSection
        pdfOutputDoneFlag={pdfOutputDoneFlag}
        csvStatus={localCsvStatus}
        onCsvStatusChange={handleCsvStatusChange}
      />

      {/* S4: 送り状番号入力セクション（D-3B） */}
      <TrackingInputSection
        lockedBundles={lockedBundles}
        csvStatus={localCsvStatus}
      />

      {/* SESSION-UNLOCK-UI-01 Phase 2: 緊急解除ボタン（概要設計書 7-2④） */}
      <div className="mt-6 pt-4 border-t border-red-100">
        <button
          type="button"
          onClick={() => setIsUnlockModalOpen(true)}
          className="w-full py-2.5 text-sm font-medium rounded
                     bg-red-50 border border-red-400 text-red-900
                     hover:bg-red-100 active:bg-red-200"
        >
          緊急セッション解除
        </button>
      </div>

      {/* 緊急解除確認モーダル（SESSION-UNLOCK-UI-01 Phase 2） */}
      <EmergencyUnlockModal
        isOpen={isUnlockModalOpen}
        onClose={() => setIsUnlockModalOpen(false)}
        onUnlockSuccess={onRefreshSession}
      />
    </div>
  );
}

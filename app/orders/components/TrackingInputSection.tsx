"use client";

// S4 送り状番号入力セクション（D-3B実装）
// 表示条件: 全キャリア（nekopos/sagawa/yamato）が done または skipped
// 各U2につき独立した入力欄と保存ボタンを表示する。

import { useState } from "react";
import type { CsvStatusMap } from "@/lib/session-store";
import type { LockedBundleInfo } from "./LockedStageView";

type Props = {
  lockedBundles: LockedBundleInfo[];
  csvStatus: CsvStatusMap;
};

type SaveState = "idle" | "saving" | "saved" | "error";

function isAllCsvDone(csvStatus: CsvStatusMap): boolean {
  return (
    (csvStatus.nekopos === "done" || csvStatus.nekopos === "skipped") &&
    (csvStatus.sagawa === "done" || csvStatus.sagawa === "skipped") &&
    (csvStatus.yamato === "done" || csvStatus.yamato === "skipped")
  );
}

type TrackingInputRowProps = {
  bundle: LockedBundleInfo;
};

function TrackingInputRow({ bundle }: TrackingInputRowProps) {
  const initialValue = bundle.tracking_number;
  const [value, setValue] = useState(initialValue);
  const [saveState, setSaveState] = useState<SaveState>(
    initialValue !== "" ? "saved" : "idle"
  );
  const [errorMsg, setErrorMsg] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setSaveState("idle");
    setErrorMsg("");
  };

  const handleSave = async () => {
    setSaveState("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/session/tracking", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle_group_id: bundle.bundle_group_id,
          tracking_number: value,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        setErrorMsg(
          data.message ?? "保存に失敗しました。再試行してください。"
        );
        setSaveState("error");
        return;
      }
      setSaveState("saved");
    } catch {
      setErrorMsg("ネットワークエラーが発生しました。再試行してください。");
      setSaveState("error");
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-700">
          {bundle.receiver_name}
        </span>
        <span className="text-xs text-gray-400">{bundle.carrier}</span>
      </div>

      <label className="text-xs text-gray-600">送り状番号（任意）</label>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={handleChange}
          placeholder="例: 123456789012"
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
        />
        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={() => void handleSave()}
          className="text-sm px-3 py-1.5 rounded border border-blue-500 text-blue-600 bg-white hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {saveState === "saving" ? "保存中..." : "保存"}
        </button>
      </div>

      {saveState === "saved" && (
        <p className="text-xs text-green-600">✅ 保存済み</p>
      )}
      {saveState === "error" && errorMsg && (
        <p className="text-xs text-red-600">{errorMsg}</p>
      )}
    </div>
  );
}

export default function TrackingInputSection({
  lockedBundles,
  csvStatus,
}: Props) {
  if (!isAllCsvDone(csvStatus)) return null;

  return (
    <div className="mt-4 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
      <h3 className="text-sm font-medium text-gray-700 mb-3">
        送り状番号入力（S4）
      </h3>

      <div className="flex flex-col gap-4">
        {lockedBundles.map((bundle) => (
          <TrackingInputRow key={bundle.bundle_group_id} bundle={bundle} />
        ))}
      </div>

      {/* S5への導線（Step 4-E実装まで disabled） */}
      <div className="mt-4 pt-3 border-t border-gray-100">
        <button
          type="button"
          disabled
          className="w-full py-2.5 text-sm font-medium rounded border border-gray-300 bg-gray-50 text-gray-400 cursor-not-allowed"
        >
          チェックシートへ進む（Step 4-Eで実装予定）
        </button>
      </div>
    </div>
  );
}

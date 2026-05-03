"use client";

type Props = {
  onContinue: () => void;
  onCancel: () => void;
};

export default function ReceiptNameWarningModal({ onContinue, onCancel }: Props) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-6">
        <p className="text-sm text-gray-800 mb-6">
          領収書宛名が未入力の注文があります。このまま出力しますか？
        </p>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
          >
            戻る
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
          >
            続行
          </button>
        </div>
      </div>
    </div>
  );
}

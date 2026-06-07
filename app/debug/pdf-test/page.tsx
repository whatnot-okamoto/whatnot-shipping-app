"use client";

// 現時点ではNextAuth認証済みユーザーのみ利用可。
// 将来、複数スタッフアカウント化した場合は、このページを管理者限定にするか検討が必要。
// 今回は権限ロール実装までは行わない。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function PdfTestPage() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [uniqueKey, setUniqueKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withReceipt, setWithReceipt] = useState(false);
  const [receiptUniqueKey, setReceiptUniqueKey] = useState("");
  const [receiptName, setReceiptName] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  // ページ表示時に認証状態を確認し、未認証ならログインページへリダイレクト
  useEffect(() => {
    fetch("/api/session/current", { method: "GET" })
      .then((res) => {
        if (res.status === 401) {
          router.replace("/login");
        } else {
          setAuthReady(true);
        }
      })
      .catch(() => {
        // ネットワークエラー時はページを表示（API 呼び出し時に再度チェックされる）
        setAuthReady(true);
      });
  }, [router]);

  async function handleReceiptSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!receiptUniqueKey.trim()) {
      setReceiptError("注文 unique_key を入力してください。");
      return;
    }

    setReceiptError(null);
    setReceiptLoading(true);

    try {
      const res = await fetch("/api/debug/pdf-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unique_key: receiptUniqueKey.trim(),
          receiptOnly: true,
          receipt_name: receiptName.trim(),
          receipt_note: receiptNote.trim(),
        }),
      });

      if (res.status === 401) {
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        let errorMessage = "PDF生成に失敗しました。";
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errorMessage = data.error;
        } catch {
          // JSON 解析失敗時は汎用メッセージを使用
        }
        setReceiptError(errorMessage);
        return;
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      let filename = "BASE領収書.pdf";
      const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match) {
        filename = decodeURIComponent(utf8Match[1]);
      } else {
        const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
        if (asciiMatch) filename = asciiMatch[1];
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setReceiptError("通信エラーが発生しました。再試行してください。");
    } finally {
      setReceiptLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uniqueKey.trim()) {
      setError("注文 unique_key を入力してください。");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/debug/pdf-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unique_key: uniqueKey.trim(), withReceipt }),
      });

      if (res.status === 401) {
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        let errorMessage = "PDF生成に失敗しました。";
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errorMessage = data.error;
        } catch {
          // JSON 解析失敗時は汎用メッセージを使用
        }
        setError(errorMessage);
        return;
      }

      // PDF ダウンロード処理
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      let filename = "TEST_BASE納品書.pdf";
      const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match) {
        filename = decodeURIComponent(utf8Match[1]);
      } else {
        const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
        if (asciiMatch) filename = asciiMatch[1];
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("通信エラーが発生しました。再試行してください。");
    } finally {
      setLoading(false);
    }
  }

  if (!authReady) {
    return null;
  }

  return (
    <main className="p-8 max-w-lg mx-auto">
      {/* 領収書再発行補助セクション */}
      <section className="mb-10">
        <h1 className="text-xl font-bold mb-3">領収書再発行補助</h1>
        <div className="mb-4 p-3 bg-blue-50 border border-blue-300 rounded text-blue-900 text-sm">
          領収書再発行補助用の画面です。出力履歴は保存されません。宛名・但し書き・金額等の内容を確認のうえ使用してください。
        </div>

        <form onSubmit={handleReceiptSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="receipt-unique-key"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              BASE 注文 unique_key
            </label>
            <input
              id="receipt-unique-key"
              type="text"
              value={receiptUniqueKey}
              onChange={(e) => setReceiptUniqueKey(e.target.value)}
              placeholder="例: XXXXXXXXXXXXXXXX"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={receiptLoading}
            />
          </div>

          <div>
            <label
              htmlFor="receipt-name"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              宛名
            </label>
            <input
              id="receipt-name"
              type="text"
              value={receiptName}
              onChange={(e) => setReceiptName(e.target.value)}
              placeholder="例: 山田 太郎"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={receiptLoading}
            />
          </div>

          <div>
            <label
              htmlFor="receipt-note"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              但し書き
            </label>
            <input
              id="receipt-note"
              type="text"
              value={receiptNote}
              onChange={(e) => setReceiptNote(e.target.value)}
              placeholder="例: お品代として"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={receiptLoading}
            />
          </div>

          {receiptError && (
            <div className="p-3 bg-red-50 border border-red-300 rounded text-red-800 text-sm">
              {receiptError}
            </div>
          )}

          <button
            type="submit"
            disabled={receiptLoading}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm font-medium"
          >
            {receiptLoading ? "PDF出力中..." : "領収書 PDF を出力する"}
          </button>
        </form>
      </section>

      <hr className="mb-10 border-gray-200" />

      {/* 納品書出力セクション */}
      <section>
        <h2 className="text-lg font-bold mb-6">納品書出力</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="unique-key"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              BASE 注文 unique_key
            </label>
            <input
              id="unique-key"
              type="text"
              value={uniqueKey}
              onChange={(e) => setUniqueKey(e.target.value)}
              placeholder="例: XXXXXXXXXXXXXXXX"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withReceipt}
                onChange={(e) => setWithReceipt(e.target.checked)}
                disabled={loading}
                className="w-4 h-4"
              />
              <span className="text-sm font-medium text-gray-700">
                領収書セクションを含める
              </span>
            </label>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-300 rounded text-red-800 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm font-medium"
          >
            {loading ? "PDF出力中..." : "PDFを出力する"}
          </button>
        </form>
      </section>
    </main>
  );
}

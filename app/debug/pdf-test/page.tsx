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
      {/* 検証専用バナー（非表示禁止） */}
      <div className="mb-6 p-3 bg-yellow-100 border border-yellow-400 rounded text-yellow-900 font-bold text-sm">
        【検証専用】このページは帳票確認専用です。通常の出荷業務には使用しないでください。
      </div>

      <h1 className="text-xl font-bold mb-6">帳票確認（検証専用）</h1>

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
              領収書セクションを含める（検証専用）
            </span>
          </label>
          <p className="text-xs text-gray-500 ml-6">
            検証専用です。正式な領収書再発行ではありません。
          </p>
          {withReceipt && (
            <div className="ml-6 p-2 bg-orange-50 border border-orange-300 rounded text-xs text-orange-800">
              領収書セクション込み・検証専用・正式な領収書再発行ではありません
            </div>
          )}
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
    </main>
  );
}

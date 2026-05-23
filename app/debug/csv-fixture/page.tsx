"use client";

// TEST-CSV-FIXTURE-01
// CSV列構造・形式検証専用ページ。
// fixtureパターン（CSV-F-01〜CSV-F-03）を選択してCSVをダウンロードできる。
// BASE API・Upstash・activeセッションへの接続なし。
// 通常出荷フローへのリンク・ナビゲーションなし。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CSV_FIXTURE_PATTERN_IDS,
  CSV_FIXTURE_LABELS,
  type CsvFixturePattern,
} from "@/lib/csv-fixture-data";

export default function CsvFixturePage() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [patternId, setPatternId] = useState<CsvFixturePattern>("CSV-F-01");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/debug/csv-fixture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern_id: patternId }),
      });

      if (res.status === 401) {
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        let errorMessage = "CSV生成に失敗しました。";
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errorMessage = data.error;
        } catch {
          // JSON 解析失敗時は汎用メッセージを使用
        }
        setError(errorMessage);
        return;
      }

      // CSV ダウンロード処理
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      let filename = `TEST_FIXTURE_${patternId}.csv`;
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
        これは検証専用導線です。生成されたCSVを実出荷・送り状印刷・確定処理・発送処理には使用しないでください。
      </div>

      <h1 className="text-xl font-bold mb-6">CSV fixture確認（検証専用）</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="pattern-id"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            fixtureパターン
          </label>
          <select
            id="pattern-id"
            value={patternId}
            onChange={(e) => setPatternId(e.target.value as CsvFixturePattern)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          >
            {CSV_FIXTURE_PATTERN_IDS.map((id) => (
              <option key={id} value={id}>
                {CSV_FIXTURE_LABELS[id]}
              </option>
            ))}
          </select>
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
          {loading ? "CSV出力中..." : "CSVをダウンロードする"}
        </button>
      </form>
    </main>
  );
}

// POST /api/debug/csv-fixture
// 検証専用: fixtureパターン（CSV-F-01〜CSV-F-03）を受け取り、送り状CSVを生成して返す。
// Upstash書き込み・フラグ更新・BASE書き戻し・activeセッション接続は一切行わない。
// エラーレスポンスにスタックトレース・内部構造・個人情報を含めない（詳細はサーバーログのみ）。

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  generateYamatoNekoposCsv,
  generateSagawaCsv,
  CsvGeneratorError,
} from "@/lib/csv-generator";
import {
  CSV_FIXTURE_DATA,
  CSV_FIXTURE_PATTERN_IDS,
  makeCsvFixtureUnit,
  type CsvFixturePattern,
} from "@/lib/csv-fixture-data";

const ERROR_GENERIC = "CSV生成に失敗しました。";

function getJstTimestamp(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";

  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

export async function POST(req: Request) {
  // (1) 認証チェック（必須・最優先）
  const authError = await requireAuth(req);
  if (authError) return authError;

  // (2) リクエストボディから fixture パターン ID を取得
  let patternId: string;
  try {
    const body = (await req.json()) as { pattern_id?: string };
    patternId = (body.pattern_id ?? "").trim();
  } catch {
    return NextResponse.json(
      { error: "リクエストの解析に失敗しました。" },
      { status: 400 }
    );
  }

  // (3) パターン ID の検証
  if (!CSV_FIXTURE_PATTERN_IDS.includes(patternId as CsvFixturePattern)) {
    return NextResponse.json(
      {
        error: `不正なパターンIDです。CSV-F-01〜CSV-F-08 のいずれかを指定してください。(受信値: "${patternId}")`,
      },
      { status: 400 }
    );
  }

  const fixture = CSV_FIXTURE_DATA[patternId as CsvFixturePattern];
  const unit = makeCsvFixtureUnit(fixture.order);

  try {
    // (4) CSV生成（lib/csv-generator.ts の既存ロジックをそのまま使用）
    let csvBuffer: Buffer;
    if (fixture.carrier === "sagawa") {
      csvBuffer = generateSagawaCsv([unit]);
    } else {
      csvBuffer = generateYamatoNekoposCsv([unit], fixture.carrier);
    }

    // (5) レスポンス: Content-Disposition に TEST_FIXTURE_{ID}_{日時}.csv 形式を設定
    const timestamp = getJstTimestamp();
    const filenameAscii = `TEST_FIXTURE_${patternId}_${timestamp}.csv`;
    const filenameEncoded = encodeURIComponent(filenameAscii);
    const contentDisposition =
      `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameEncoded}`;

    return new Response(new Uint8Array(csvBuffer), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=Shift_JIS",
        "Content-Disposition": contentDisposition,
      },
    });
  } catch (error) {
    if (error instanceof CsvGeneratorError) {
      console.error("[debug/csv-fixture] CsvGeneratorError:", error.message);
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error(
      "[debug/csv-fixture] error:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

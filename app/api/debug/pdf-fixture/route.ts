// POST /api/debug/pdf-fixture
// 検証専用: fixtureパターン（F-01〜F-08）を受け取り、納品書PDFを生成して返す。
// Upstash書き込み・フラグ更新・BASE書き戻し・activeセッション接続は一切行わない。
// エラーレスポンスにスタックトレース・内部構造・個人情報を含めない（詳細はサーバーログのみ）。

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  checkTaxRates,
  generateShippingDocumentsPdf,
} from "@/lib/pdf-generator";
import {
  FIXTURE_DATA,
  FIXTURE_PATTERN_IDS,
  type FixturePattern,
} from "@/lib/pdf-fixture-data";

const ERROR_GENERIC = "PDF生成に失敗しました。";
const ERROR_TAX_8PERCENT =
  "8%対象商品が含まれているため、PDF出力を停止しました。税率別集計の確認が必要です。担当者に連絡してください。";
const ERROR_TAX_UNKNOWN =
  "税率情報が取得できない商品が含まれているため、PDF出力を停止しました。商品データの確認が必要です。担当者に連絡してください。";

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
  if (!FIXTURE_PATTERN_IDS.includes(patternId as FixturePattern)) {
    return NextResponse.json(
      {
        error: `不正なパターンIDです。F-01〜F-13 のいずれかを指定してください。(受信値: "${patternId}")`,
      },
      { status: 400 }
    );
  }

  const fixture = FIXTURE_DATA[patternId as FixturePattern];

  try {
    // (4) PDF-AMOUNT-01 税率チェック（pdf-preview と同仕様）
    const taxCheck = checkTaxRates([fixture.order]);
    if (!taxCheck.ok) {
      const errorMessage =
        taxCheck.reason === "has8percent"
          ? ERROR_TAX_8PERCENT
          : ERROR_TAX_UNKNOWN;
      return NextResponse.json({ error: errorMessage }, { status: 422 });
    }

    // (5) PDF 生成（lib/pdf-generator.ts の既存ロジックをそのまま使用）
    const pdfBytes = await generateShippingDocumentsPdf([
      { order: fixture.order, orderState: fixture.orderState },
    ]);

    // (6) レスポンス: Content-Disposition に TEST_FIXTURE_{ID}_{日時}.pdf 形式を設定
    const timestamp = getJstTimestamp();
    const filenameAscii = `TEST_FIXTURE_${patternId}_${timestamp}.pdf`;
    const filenameJa = `TEST_FIXTURE_${patternId}_${timestamp}.pdf`;
    const filenameEncoded = encodeURIComponent(filenameJa);
    const contentDisposition =
      `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameEncoded}`;

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition,
      },
    });
  } catch (error) {
    console.error(
      "[debug/pdf-fixture] error:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

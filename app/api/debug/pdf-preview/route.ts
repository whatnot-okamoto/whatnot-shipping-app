// POST /api/debug/pdf-preview
// 検証専用: 任意の BASE 注文 unique_key を受け取り、納品書 PDF を生成して返す。
// Upstash 書き込み・フラグ更新・BASE 書き戻しは一切行わない。
// エラーレスポンスにスタックトレース・内部構造・個人情報を含めない（詳細はサーバーログのみ）。

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { fetchOrderDetail } from "@/lib/base-api";
import { checkTaxRates, generateShippingDocumentsPdf } from "@/lib/pdf-generator";
import type { U1Data } from "@/lib/order-store";

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

  // (2) リクエストボディから unique_key を取得
  let uniqueKey: string;
  let withReceipt: boolean;
  try {
    const body = (await req.json()) as { unique_key?: string; withReceipt?: boolean };
    uniqueKey = (body.unique_key ?? "").trim();
    withReceipt = body.withReceipt === true;
  } catch {
    return NextResponse.json(
      { error: "リクエストの解析に失敗しました。" },
      { status: 400 }
    );
  }

  if (!uniqueKey) {
    return NextResponse.json(
      { error: "unique_key を指定してください。" },
      { status: 400 }
    );
  }

  try {
    // (3) BASE API から注文詳細を取得（読み取りのみ）
    const order = await fetchOrderDetail(uniqueKey);

    // (4) PDF-AMOUNT-01 税率チェック（通常 PDF 生成 API と同仕様）
    const taxCheck = checkTaxRates([order]);
    if (!taxCheck.ok) {
      const errorMessage =
        taxCheck.reason === "has8percent"
          ? ERROR_TAX_8PERCENT
          : ERROR_TAX_UNKNOWN;
      return NextResponse.json({ error: errorMessage }, { status: 422 });
    }

    // (5) 検証用デフォルト U1Data（Upstash 不使用・フラグ更新なし）
    // withReceipt===true の場合のみ receipt_required を in-memory で true に付与する。
    // Upstash KV・BASE API・キャッシュへの書き込みは一切行わない。
    const orderState: U1Data = {
      unique_key: order.unique_key,
      hold_flag: false,
      hold_reason: "",
      carrier: "",
      receipt_required: withReceipt,
      receipt_name: "",
      receipt_note: "",
      app_memo: "",
      cancelled_flag: false,
    };

    // (6) PDF 生成（lib/pdf-generator.ts の既存ロジックをそのまま使用）
    const pdfBytes = await generateShippingDocumentsPdf([{ order, orderState }]);

    // (7) PDF バイナリをレスポンスとして返す
    const timestamp = getJstTimestamp();
    const uniqueKeySuffix = uniqueKey.slice(-8);
    const filenameJa = withReceipt
      ? `TEST_BASE納品書領収書_${uniqueKeySuffix}_${timestamp}.pdf`
      : `TEST_BASE納品書_${uniqueKeySuffix}_${timestamp}.pdf`;
    const filenameAscii = withReceipt
      ? `TEST_BASE_delivery_receipt_${uniqueKeySuffix}_${timestamp}.pdf`
      : `TEST_BASE_delivery_${uniqueKeySuffix}_${timestamp}.pdf`;
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
      "[debug/pdf-preview] error:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

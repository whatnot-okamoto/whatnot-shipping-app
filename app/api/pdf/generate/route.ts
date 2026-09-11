// POST /api/pdf/generate
// ロック対象注文の納品書・領収書PDFを一括生成して返す。
// 生成成功後に session:{session_id}.pdf_output_done_flag を true に更新する。
// エラーレスポンスにスタックトレース・内部構造を含めない（詳細はサーバーログのみ）。

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";
import { fetchOrderDetail } from "@/lib/base-api";
import { getBundleStates, getOrderStates } from "@/lib/order-store";
import { checkTaxRates, checkPaymentLabels, generateShippingDocumentsPdf } from "@/lib/pdf-generator";
import { prepareOrdersForPdf } from "@/lib/pdf-order-assessment";

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
  const authError = await requireAuth(req);
  if (authError) return authError;

  try {
    // (1) session:current から session_id 取得
    const sessionId = await redis.get<string>("session:current");
    if (!sessionId) {
      return NextResponse.json(
        { error: "アクティブなセッションが存在しません。" },
        { status: 400 }
      );
    }

    // (2) session:{session_id} から locked_bundle_group_ids 取得
    const sessionRaw = await redis.get(`session:${sessionId}`);
    if (!sessionRaw) {
      return NextResponse.json(
        { error: "セッションデータが見つかりません。" },
        { status: 400 }
      );
    }
    const session =
      typeof sessionRaw === "string"
        ? (JSON.parse(sessionRaw) as Record<string, unknown>)
        : (sessionRaw as Record<string, unknown>);

    const lockedBundleGroupIds: string[] = Array.isArray(
      session.locked_bundle_group_ids
    )
      ? (session.locked_bundle_group_ids as string[])
      : [];

    if (lockedBundleGroupIds.length === 0) {
      return NextResponse.json(
        { error: "ロック対象の注文がありません。" },
        { status: 400 }
      );
    }

    // (3) bundle_group_id → order_unique_keys 展開（U2→U1）
    const bundleMap = await getBundleStates(lockedBundleGroupIds);
    const allUniqueKeys: string[] = [];
    for (const bgId of lockedBundleGroupIds) {
      const bundle = bundleMap.get(bgId);
      if (bundle) {
        for (const uk of bundle.order_unique_keys) {
          if (!allUniqueKeys.includes(uk)) {
            allUniqueKeys.push(uk);
          }
        }
      }
    }

    if (allUniqueKeys.length === 0) {
      return NextResponse.json(
        { error: "PDF対象の注文が見つかりません。" },
        { status: 400 }
      );
    }

    // (4) BASE詳細API逐次取得（ロック対象のみ・初回は逐次・無制限並列禁止）
    const orders = [];
    const failedOrders: Array<{ unique_key: string; reason: "base_order_fetch_failed" }> = [];
    for (const uk of allUniqueKeys) {
      try {
        const order = await fetchOrderDetail(uk);
        orders.push(order);
      } catch {
        failedOrders.push({ unique_key: uk, reason: "base_order_fetch_failed" });
      }
    }
    if (failedOrders.length > 0) {
      return NextResponse.json(
        {
          outcome: "retryable_error",
          error: "一部の注文詳細を取得できませんでした。セッションを維持したまま再試行してください。",
          failed_orders: failedOrders,
        },
        { status: 503 }
      );
    }

    const preparation = prepareOrdersForPdf(orders);
    const blockedOrders = preparation.assessments
      .filter(({ assessment }) => assessment.generationOutcome === "blocked")
      .map(({ unique_key, assessment }) => ({
        unique_key,
        cancellation_state: assessment.cancellationState,
        issues: assessment.issues,
      }));
    if (blockedOrders.length > 0) {
      return NextResponse.json(
        {
          outcome: "blocked",
          error: "アプリで自動処理できない注文が含まれています。対象注文と理由を確認してください。",
          blocked_orders: blockedOrders,
        },
        { status: 422 }
      );
    }
    const preparedOrders = preparation.preparedOrders;

    // (4-b) PDF-AMOUNT-01 商品税率チェック
    //   - 8%商品は通常出力する
    //   - 税率不明商品だけがPDF出力停止・HTTP 422の対象
    //   - has8percent分岐は既存参照として残るが、現在のcheckTaxRatesからは返らない
    //   - エラー時もpdf_output_done_flagは変更しない
    const taxCheck = checkTaxRates(preparedOrders);
    if (!taxCheck.ok) {
      const errorMessage =
        taxCheck.reason === "has8percent" ? ERROR_TAX_8PERCENT : ERROR_TAX_UNKNOWN;
      return NextResponse.json({ error: errorMessage }, { status: 422 });
    }

    // (4-c) PAYMENT-LABEL-UNKNOWN-01 支払い方法ラベル未定義チェック（警告モデル・停止しない）
    //   - checkTaxRates 通過後のみ実行（税率エラー時は早期 return 済み）
    const paymentLabelCheck = checkPaymentLabels(preparedOrders);

    // (5) U1データ取得（receipt設定・carrier）
    const orderStateMap = await getOrderStates(allUniqueKeys);

    // (6) 入力データ組み立て（U1不在は全体失敗）
    const inputs = [];
    for (const order of preparedOrders) {
      const orderState = orderStateMap.get(order.unique_key);
      if (!orderState) {
        console.error(
          `[pdf/generate] U1データ不在: ${order.unique_key}`
        );
        return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
      }
      inputs.push({ order, orderState });
    }

    // (7) PDF生成（失敗は全体失敗）
    const pdfBytes = await generateShippingDocumentsPdf(inputs);

    // (9) pdf_output_done_flag を true に更新
    //     レスポンス返却前に更新。部分成功状態（PDF返却済み・フラグ未更新）を作らない。
    const updatedSession = { ...session, pdf_output_done_flag: true };
    await redis.set(`session:${sessionId}`, JSON.stringify(updatedSession));

    // (10) PDFバイナリをレスポンスとして返す
    const timestamp = getJstTimestamp();
    const filenameAscii = `whatnot-shipping-${timestamp}.pdf`;
    const filenameJa = `BASE納品書_${timestamp}.pdf`;
    const filenameEncoded = encodeURIComponent(filenameJa);
    const contentDisposition =
      `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameEncoded}`;

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", "application/pdf");
    responseHeaders.set("Content-Disposition", contentDisposition);

    if (paymentLabelCheck.hasUnknownPayment) {
      const payload = JSON.stringify({
        values: paymentLabelCheck.unknownPaymentValues,
        affectedCount: paymentLabelCheck.affectedCount,
      });
      responseHeaders.set("X-Payment-Label-Unknown", encodeURIComponent(payload));
    }

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: responseHeaders,
    });
  } catch {
    console.error(
      "[pdf/generate] fatal error"
    );
    return NextResponse.json(
      { outcome: "fatal_error", error: ERROR_GENERIC },
      { status: 500 }
    );
  }
}

// POST /api/pdf/generate
// ロック対象注文の納品書・領収書PDFを一括生成して返す。
// 生成成功後に session:{session_id}.pdf_output_done_flag を true に更新する。
// エラーレスポンスにスタックトレース・内部構造を含めない（詳細はサーバーログのみ）。

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";
import { fetchOrderDetail } from "@/lib/base-api";
import { getBundleStates, getOrderStates } from "@/lib/order-store";
import { generateShippingDocumentsPdf } from "@/lib/pdf-generator";

const ERROR_GENERIC = "PDF生成に失敗しました。";

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
    for (const uk of allUniqueKeys) {
      const order = await fetchOrderDetail(uk);
      orders.push(order);
    }

    // (5) U1データ取得（receipt設定・carrier）
    const orderStateMap = await getOrderStates(allUniqueKeys);

    // (6) 入力データ組み立て（U1不在は全体失敗）
    const inputs = [];
    for (const order of orders) {
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
    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="shipping-documents-${sessionId}.pdf"`,
      },
    });
  } catch (error) {
    console.error(
      "[pdf/generate] error:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

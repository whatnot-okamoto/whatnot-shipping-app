// POST /api/csv/generate
// S3 CSV出力（D-3A実装）
// キャリアごとに順序制御・U2展開・D案フォールバック・文字数チェックを実施してCSVを返す。
// エラーレスポンスにスタックトレース・内部構造を含めない。

import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";
import { fetchOrderDetail } from "@/lib/base-api";
import { getBundleStates, getOrderStates } from "@/lib/order-store";
import {
  generateYamatoNekoposCsv,
  generateSagawaCsv,
  expandU2ToCsvUnits,
  CsvGeneratorError,
  type CsvCarrier,
  type CsvInputUnit,
} from "@/lib/csv-generator";
import type { U3Data, CsvStatusMap } from "@/lib/session-store";

type RequestBody = {
  carrier: CsvCarrier;
};

/** session:{session_id} の csv_status[carrier] を指定ステータスに更新する（パース・保存込み）。 */
async function updateCsvStatus(
  sessionId: string,
  sessionRaw: unknown,
  carrier: CsvCarrier,
  status: CsvStatusMap[CsvCarrier]
): Promise<void> {
  const session: U3Data =
    typeof sessionRaw === "string"
      ? (JSON.parse(sessionRaw) as U3Data)
      : (sessionRaw as U3Data);
  const current: CsvStatusMap = session.csv_status ?? {
    nekopos: "pending",
    sagawa: "pending",
    yamato: "pending",
  };
  const updated: U3Data = {
    ...session,
    csv_status: { ...current, [carrier]: status },
  };
  await redis.set(`session:${sessionId}`, JSON.stringify(updated));
}

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  // (0) リクエストボディ検証
  let body: RequestBody;
  try {
    const parsed = (await req.json()) as { carrier?: unknown };
    const carrier = parsed.carrier;
    if (
      carrier !== "nekopos" &&
      carrier !== "sagawa" &&
      carrier !== "yamato"
    ) {
      return Response.json(
        { status: "error", message: "carrier は nekopos / sagawa / yamato のいずれかを指定してください。" },
        { status: 400 }
      );
    }
    body = { carrier };
  } catch {
    return Response.json(
      { status: "error", message: "リクエストボディの解析に失敗しました。" },
      { status: 400 }
    );
  }

  const { carrier } = body;

  // (1) session:current から session_id を取得
  const sessionId = await redis.get<string>("session:current");
  if (!sessionId) {
    return Response.json(
      { status: "error", message: "アクティブなセッションが存在しません。" },
      { status: 400 }
    );
  }

  // (2) session:{session_id} を取得
  const sessionRaw = await redis.get(`session:${sessionId}`);
  if (!sessionRaw) {
    return Response.json(
      { status: "error", message: "セッションデータが見つかりません。" },
      { status: 400 }
    );
  }
  const session: U3Data =
    typeof sessionRaw === "string"
      ? (JSON.parse(sessionRaw) as U3Data)
      : (sessionRaw as U3Data);

  if (session.session_status !== "active") {
    return Response.json(
      { status: "error", message: "セッションがアクティブではありません。" },
      { status: 400 }
    );
  }

  const csvStatus: CsvStatusMap = session.csv_status ?? {
    nekopos: "pending",
    sagawa: "pending",
    yamato: "pending",
  };

  // (3) pdf_output_done_flag が false なら 400
  if (!session.pdf_output_done_flag) {
    return Response.json(
      {
        status: "error",
        message:
          "PDF出力が完了していません。先に納品書・領収書のPDF出力を実行してください。",
      },
      { status: 400 }
    );
  }

  // (4) キャリア順序制御（FLOW-01 R1: ネコポス→佐川→ヤマトの順序固定）
  if (carrier === "sagawa") {
    const nekoposStatus = csvStatus.nekopos;
    if (nekoposStatus !== "done" && nekoposStatus !== "skipped") {
      return Response.json(
        {
          status: "error",
          message:
            "佐川CSV出力はネコポスCSV出力が完了（done または skipped）してから実行してください。",
        },
        { status: 400 }
      );
    }
  }
  if (carrier === "yamato") {
    const sagawaStatus = csvStatus.sagawa;
    if (sagawaStatus !== "done" && sagawaStatus !== "skipped") {
      return Response.json(
        {
          status: "error",
          message:
            "ヤマトCSV出力は佐川CSV出力が完了（done または skipped）してから実行してください。",
        },
        { status: 400 }
      );
    }
  }

  // (5) 対象キャリアの U2 群を抽出
  const lockedBundleGroupIds: string[] = Array.isArray(
    session.locked_bundle_group_ids
  )
    ? (session.locked_bundle_group_ids as string[])
    : [];

  if (lockedBundleGroupIds.length === 0) {
    return Response.json(
      { status: "error", message: "ロック対象の注文がありません。" },
      { status: 400 }
    );
  }

  const bundleMap = await getBundleStates(lockedBundleGroupIds);

  // U2ごとの代表注文の carrier を確認して対象キャリアの U2 を抽出
  const allRepUniqueKeys: string[] = [];
  for (const bgId of lockedBundleGroupIds) {
    const bundle = bundleMap.get(bgId);
    if (bundle) allRepUniqueKeys.push(bundle.representative_order_unique_key);
  }
  const u1Map = await getOrderStates(allRepUniqueKeys);

  const targetBundleGroupIds = lockedBundleGroupIds.filter((bgId) => {
    const bundle = bundleMap.get(bgId);
    if (!bundle) return false;
    const repU1 = u1Map.get(bundle.representative_order_unique_key);
    return repU1?.carrier === carrier;
  });

  // (6) U2 が 0 件の場合: skipped
  if (targetBundleGroupIds.length === 0) {
    await updateCsvStatus(sessionId, sessionRaw, carrier, "skipped");
    return Response.json({ status: "skipped", carrier });
  }

  // (7)〜(10) 各 U2 の注文詳細を取得して CSV 単位を構築
  const csvUnits: CsvInputUnit[] = [];
  try {
    for (const bgId of targetBundleGroupIds) {
      const bundle = bundleMap.get(bgId)!;
      const orderDetails: import("@/lib/base-api").BaseOrder[] = [];
      for (const uk of bundle.order_unique_keys) {
        const detail = await fetchOrderDetail(uk);
        orderDetails.push(detail);
      }
      const units = expandU2ToCsvUnits(
        bgId,
        bundle.bundle_enabled,
        orderDetails
      );
      for (const unit of units) {
        csvUnits.push(unit);
      }
    }
  } catch (error) {
    console.error("[csv/generate] 注文詳細取得エラー:", error instanceof Error ? error.message : String(error));
    return Response.json(
      {
        status: "error",
        message:
          "注文情報の取得に失敗しました。ネットワークを確認して再試行してください。",
      },
      { status: 500 }
    );
  }

  // (10)〜(12) CSV 生成
  let csvBuffer: Buffer;
  try {
    if (carrier === "sagawa") {
      csvBuffer = generateSagawaCsv(csvUnits);
    } else {
      csvBuffer = generateYamatoNekoposCsv(csvUnits, carrier);
    }
  } catch (error) {
    if (error instanceof CsvGeneratorError) {
      await updateCsvStatus(sessionId, sessionRaw, carrier, "error");
      return Response.json(
        { status: "error", message: error.message },
        { status: 400 }
      );
    }
    console.error("[csv/generate] CSV生成エラー:", error instanceof Error ? error.message : String(error));
    await updateCsvStatus(sessionId, sessionRaw, carrier, "error");
    return Response.json(
      {
        status: "error",
        message:
          "CSV生成中にエラーが発生しました。内容を確認して再試行してください。",
      },
      { status: 500 }
    );
  }

  // (12) csv_status[carrier] = "done" を保存
  await updateCsvStatus(sessionId, sessionRaw, carrier, "done");

  // (13) CSV ファイルとしてレスポンスを返す
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  const filename = `${carrier}_${timestamp}.csv`;

  return new Response(Buffer.from(csvBuffer), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=shift-jis",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

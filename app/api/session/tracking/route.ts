// PUT /api/session/tracking
// U2（bundle:{bundle_group_id}）の tracking_number を更新する。
// 空文字も許容する。既存の U2 フィールドを維持したままスプレッドで更新する。

import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";
import { getCurrentSession } from "@/lib/session-store";
import { getBundleState } from "@/lib/order-store";
import type { U2Data } from "@/lib/order-store";

export async function PUT(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  // (0) リクエストボディ検証
  let bundleGroupId: string;
  let trackingNumber: string;
  try {
    const parsed = (await req.json()) as {
      bundle_group_id?: unknown;
      tracking_number?: unknown;
    };
    if (typeof parsed.bundle_group_id !== "string" || !parsed.bundle_group_id) {
      return Response.json(
        { status: "error", message: "bundle_group_id は必須です。" },
        { status: 400 }
      );
    }
    if (typeof parsed.tracking_number !== "string") {
      return Response.json(
        {
          status: "error",
          message: "tracking_number は文字列で指定してください。",
        },
        { status: 400 }
      );
    }
    bundleGroupId = parsed.bundle_group_id;
    trackingNumber = parsed.tracking_number;
  } catch {
    return Response.json(
      { status: "error", message: "リクエストボディの解析に失敗しました。" },
      { status: 400 }
    );
  }

  // (1) アクティブなセッションを取得
  const session = await getCurrentSession();
  if (!session) {
    return Response.json(
      { status: "error", message: "アクティブなセッションが存在しません。" },
      { status: 400 }
    );
  }

  // (2) session_status が "active" であることを確認
  if (session.session_status !== "active") {
    return Response.json(
      { status: "error", message: "セッションがアクティブではありません。" },
      { status: 400 }
    );
  }

  // (3) locked_bundle_group_ids に含まれていることを確認
  if (!session.locked_bundle_group_ids.includes(bundleGroupId)) {
    return Response.json(
      {
        status: "error",
        message:
          "指定された同梱グループは現在の出荷セッションに含まれていません。",
      },
      { status: 400 }
    );
  }

  // (4) bundle:{bundle_group_id} を取得
  const bundle = await getBundleState(bundleGroupId);
  if (!bundle) {
    return Response.json(
      { status: "error", message: "同梱グループデータが見つかりません。" },
      { status: 400 }
    );
  }

  // (5) tracking_number を更新して保存（他フィールドを維持）
  const updated: U2Data = { ...bundle, tracking_number: trackingNumber };
  await redis.set(`bundle:${bundleGroupId}`, JSON.stringify(updated));

  return Response.json({ status: "ok" });
}

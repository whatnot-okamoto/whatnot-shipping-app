// U1・U2・U4 Upstash 初期化（DATA-01 準拠）
//
// 【U3はこのファイルの対象外】
//   U3（セッション単位）はセッションロック側の責務。Step 5 で実装する。
//
// 【キーを跨ぐ更新の整合（DATA-01 §5）】
//   U1・U2・U4・インデックスキーの全書き込みを pipeline で 1 回の HTTP リクエストに集約する。
//   一部のみ書き込んだ状態で処理が終了することを防ぐ構造にする。

import { redis } from "@/lib/upstash";
import type { BaseOrder } from "@/lib/base-api";
import {
  classifyShippingMethod,
  DEFAULT_SHIPPING_METHOD_MAPPING,
  type CarrierCategory,
  type Carrier,
} from "@/lib/carrier-mapping";

// ============================================================================
// Upstash 保存型定義（DATA-01 §2 保存対象の定義 準拠）
// ============================================================================

/**
 * U1: `order:{order_id}` に保存するデータ。
 * 注文基本情報・商品明細・配送方法は BASE API から都度取得するため保存しない（DATA-01 U1）。
 */
export type U1Data = {
  hold_flag: boolean;
  hold_reason: string;
  carrier: Carrier | "";  // "" = 未選択（non-delivery・unknown・スタッフ未選択）
  receipt_required: boolean;
  receipt_name: string;
  receipt_note: string;
  app_memo: string;
  cancelled_flag: boolean;
};

/**
 * U2: `bundle:{bundle_group_id}` に保存するデータ。
 * tracking_number は入力確定時更新（確定時更新ルール DATA-01 §3）。初期値は ""。
 */
export type U2Data = {
  order_ids: number[];
  bundle_enabled: boolean;
  representative_order_id: number;
  tracking_number: string;
};

/**
 * U4: `picking:{order_item_id}` に保存するデータ。
 * 識別子は order_item_id（BASE API 由来）。jan_code は識別子ではなく照合キー（DATA-01 U4）。
 * 残数・ピッキング完了状態は派生値のため保存しない（DATA-01 §2 禁止事項）。
 */
export type U4Data = {
  order_id: number;
  jan_code: string;
  required_quantity: number;
  scanned_quantity: number;  // 初期値 0。確認ダイアログ完了時のみ更新（DATA-01 §3）
};

// ============================================================================
// 初期化処理
// ============================================================================

export type InitializeResult = {
  u1Count: number;
  u2Count: number;
  u4Count: number;
  // 未登録配送方法を持つ注文の一覧（ORDER-01 §5 UIアラート用。Step 6 以降で使用）
  unknownMethodOrders: Array<{
    order_id: number;
    detectedMethodNames: string[];
  }>;
};

/**
 * BASE API から取得した注文一覧をもとに U1・U2・U4 を Upstash に初期化する。
 *
 * 処理順序:
 *   1. 同梱グループを生成（U2 の単位を決定）
 *   2. pipeline に U2・U1・U4・インデックスキーの全書き込みコマンドを積む
 *   3. pipeline.exec() で一括送信（整合性担保）
 */
export async function initializeOrderData(
  orders: BaseOrder[]
): Promise<InitializeResult> {
  const bundles = groupOrdersIntoU2Bundles(orders);
  const pipe = redis.pipeline();
  const unknownMethodOrders: InitializeResult["unknownMethodOrders"] = [];

  for (const [bundleGroupId, bundleOrders] of bundles) {
    // --- U2 ---
    const orderIds = bundleOrders.map((o) => o.order_id).sort((a, b) => a - b);
    const u2: U2Data = {
      order_ids: orderIds,
      bundle_enabled: true,
      representative_order_id: orderIds[0],   // 昇順最小が代表注文（DATA-01 U2）
      tracking_number: "",
    };
    pipe.set(`bundle:${bundleGroupId}`, JSON.stringify(u2));

    for (const order of bundleOrders) {
      // 配送方法カテゴリ判定（ORDER-01 §2・§3）
      const classification = classifyShippingMethod(
        order.shipping_method,
        order.shipping_lines,
        DEFAULT_SHIPPING_METHOD_MAPPING
      );

      if (classification.isUnknown) {
        unknownMethodOrders.push({
          order_id: order.order_id,
          detectedMethodNames: classification.detectedMethodNames,
        });
      }

      // --- U1 ---
      const u1: U1Data = {
        hold_flag: false,
        hold_reason: "",
        carrier: resolveInitialCarrier(classification.category),
        receipt_required: false,
        receipt_name: "",
        receipt_note: "",
        app_memo: "",
        cancelled_flag: false,
      };
      pipe.set(`order:${order.order_id}`, JSON.stringify(u1));

      // --- U4 + インデックスキー ---
      const itemIds: number[] = [];
      for (const item of order.order_items) {
        const u4: U4Data = {
          order_id: order.order_id,
          jan_code: item.barcode,
          required_quantity: item.quantity,
          scanned_quantity: 0,
        };
        pipe.set(`picking:${item.order_item_id}`, JSON.stringify(u4));
        itemIds.push(item.order_item_id);
      }
      // index:picking:{order_id}: 注文単位で U4 を引くためのインデックス（DATA-01 §5）
      pipe.set(`index:picking:${order.order_id}`, JSON.stringify(itemIds));
    }
  }

  // U1・U2・U4・インデックスキーを一括送信（整合ルール DATA-01 §5）
  await pipe.exec();

  return {
    u1Count: orders.length,
    u2Count: bundles.size,
    u4Count: orders.reduce((sum, o) => sum + o.order_items.length, 0),
    unknownMethodOrders,
  };
}

// ============================================================================
// 内部ヘルパー
// ============================================================================

/**
 * carrier の初期候補値を決定する。
 * スタッフの最終選択（DATA-01 U1 carrier フィールド）ではなく、U1 保存時の初期値。
 *
 * delivery     → "sagawa"（宅配系デフォルト。マッピングテーブル先頭候補として採用）
 *                ヤマトの可能性もあるが、スタッフが必ず S2 工程で確認・変更する
 * nekopos      → "nekopos"（カテゴリから一意に確定）
 * non-delivery → ""（出荷対象外。carrier 選択不可）
 * unknown      → ""（マッピング未登録。スタッフが手動選択する）
 */
function resolveInitialCarrier(category: CarrierCategory): Carrier | "" {
  switch (category) {
    case "delivery":     return "sagawa";
    case "nekopos":      return "nekopos";
    case "non-delivery": return "";
    case "unknown":      return "";
    default: {
      // TypeScript の網羅性チェック用（CarrierCategory に新値が追加された際にコンパイルエラーになる）
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

/**
 * 注文一覧を同梱グループ（U2 の単位）に分類する。
 *
 * グルーピング条件: 同日注文 かつ 同一顧客
 * 「同一顧客」の判定キー: receiver_name + receiver_prefecture + receiver_address
 * ※ 正式定義は DEST-01 A/D 案の実機確認後に確定する（実装参照文書 §11）。
 *   order_receiver フィールドの存在確認結果により、ここの判定キーを更新すること。
 *
 * 全注文に U2 を付与する（単独注文も「1件のみの U2」として扱う）（DATA-01 U2）。
 * bundle_group_id は UUID で生成する。
 */
function groupOrdersIntoU2Bundles(
  orders: BaseOrder[]
): Map<string, BaseOrder[]> {
  const tempGroups = new Map<string, BaseOrder[]>();

  for (const order of orders) {
    const date = order.ordered_at.slice(0, 10); // YYYY-MM-DD（同日判定）
    const customerKey = [
      order.receiver_name,
      order.receiver_prefecture,
      order.receiver_address,
    ].join("::");
    const groupKey = `${date}::${customerKey}`;

    if (!tempGroups.has(groupKey)) {
      tempGroups.set(groupKey, []);
    }
    tempGroups.get(groupKey)!.push(order);
  }

  // グルーピングキーを UUID の bundle_group_id に変換
  const bundles = new Map<string, BaseOrder[]>();
  for (const [, groupOrders] of tempGroups) {
    bundles.set(crypto.randomUUID(), groupOrders);
  }

  return bundles;
}

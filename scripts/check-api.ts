// BASE API 実機確認スクリプト（C-1〜C-5）
// 用途: 実装参照文書 §10 の初回デプロイ後実機確認
// 実行: npx tsx scripts/check-api.ts
// ※ BASE_API_TOKEN / BASE_CHECK_ORDER_UNIQUE_KEY は .env.local から dotenv 経由で読む。
// ※ 注文ID・個人情報・実取引データの値はログへ出力しない。

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_API_TOKEN = process.env.BASE_API_TOKEN;
const BASE_CHECK_ORDER_UNIQUE_KEY = process.env.BASE_CHECK_ORDER_UNIQUE_KEY;
const BASE_URL = process.env.BASE_API_BASE_URL ?? "https://api.thebase.in/1";

if (!BASE_API_TOKEN) {
  console.error("ERROR: BASE_API_TOKEN が未設定です。");
  process.exit(1);
}

if (!BASE_CHECK_ORDER_UNIQUE_KEY) {
  console.error("ERROR: BASE_CHECK_ORDER_UNIQUE_KEY が未設定です。");
  process.exit(1);
}

if (!/^[0-9a-f]+$/i.test(BASE_CHECK_ORDER_UNIQUE_KEY)) {
  console.error("ERROR: BASE_CHECK_ORDER_UNIQUE_KEY の形式が不正です。");
  process.exit(1);
}

function describeField(record: Record<string, unknown>, key: string): string {
  if (!(key in record)) {
    return "なし";
  }

  return `あり（型: ${typeof record[key]}）`;
}

function describeItemField(
  items: Record<string, unknown>[] | undefined,
  key: string
): string {
  if (!items || items.length === 0) {
    return "order_items が空または存在しない";
  }

  const presentCount = items.filter((item) => key in item).length;
  if (presentCount === 0) {
    return "全明細でなし";
  }

  if (presentCount !== items.length) {
    return "一部明細であり（値・件数は非表示）";
  }

  const valueTypes = new Set(items.map((item) => typeof item[key]));
  return `全明細であり（型: ${[...valueTypes].join(" / ")}）`;
}

async function main() {
  const headers = { Authorization: `Bearer ${BASE_API_TOKEN}` };

  console.log("=== BASE API 実機確認 ===\n");
  console.log("対象注文ID: 設定済み（値は非表示）\n");

  // --- 注文詳細取得 ---
  console.log("注文詳細取得中...");
  const detailRes = await fetch(
    `${BASE_URL}/orders/detail/${BASE_CHECK_ORDER_UNIQUE_KEY}`,
    { headers }
  );

  if (!detailRes.ok) {
    console.error(`注文詳細取得失敗: HTTP ${detailRes.status}`);
    process.exit(1);
  }

  const detailJson = await detailRes.json();
  const order = (detailJson.order ?? detailJson) as Record<string, unknown>;

  // ============================================================
  // C-1: order_receiver フィールドの存在確認
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log("【C-1】order_receiver フィールド確認");
  if ("order_receiver" in order && order.order_receiver != null) {
    const receiver = order.order_receiver as Record<string, unknown>;
    console.log("  存在: YES");
    console.log(`  name キー: ${describeField(receiver, "name")}`);
    console.log(`  zip キー: ${describeField(receiver, "zip")}`);
    console.log(`  address キー: ${describeField(receiver, "address")}`);
  } else {
    console.log("  存在: NO");
    console.log(
      `  order_purchaser キー: ${describeField(order, "order_purchaser")}`
    );
  }

  // ============================================================
  // C-2: shipping_fee フィールドの存在確認
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log("【C-2】shipping_fee フィールド確認");
  console.log(`  ${describeField(order, "shipping_fee")}`);

  // ============================================================
  // C-3: order_items[].status の確認
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log("【C-3】order_items[].status 確認");
  const items = order.order_items as Record<string, unknown>[] | undefined;
  console.log(`  ${describeItemField(items, "status")}`);

  // ============================================================
  // C-4: order_items[].order_item_id の確認
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log("【C-4】order_items[].order_item_id 確認");
  console.log(`  ${describeItemField(items, "order_item_id")}`);

  // ============================================================
  // C-5: 姓名フィールド確認（実値は出力しない）
  // ============================================================
  console.log("------------------------------------------------------------");
  console.log("【C-5】姓名フィールド確認");
  console.log(`  注文者 last_name: ${describeField(order, "last_name")}`);
  console.log(`  注文者 first_name: ${describeField(order, "first_name")}`);

  const receiver = order.order_receiver as Record<string, unknown> | undefined;
  if (receiver) {
    console.log(
      `  配送先 first_name: ${describeField(receiver, "first_name")}`
    );
    console.log(`  配送先 last_name: ${describeField(receiver, "last_name")}`);
  } else {
    console.log("  配送先姓名フィールド: order_receiver がないため未確認");
  }

  console.log("------------------------------------------------------------");
  console.log("\n=== 確認完了（実値は出力していません） ===");
}

main().catch(() => {
  console.error("予期しないエラーが発生しました（詳細は非表示）。");
  process.exit(1);
});

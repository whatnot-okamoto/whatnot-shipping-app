// BASE API 実機確認スクリプト（C-1〜C-4）
// 用途: 実装参照文書 §10 の初回デプロイ後実機確認
// 実行: npx tsx scripts/check-api.ts
// ※ BASE_API_TOKEN は .env.local から dotenv 経由で読む。直書き禁止。

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_API_TOKEN = process.env.BASE_API_TOKEN;
const BASE_URL = process.env.BASE_API_BASE_URL ?? "https://api.thebase.in/1";

if (!BASE_API_TOKEN) {
  console.error("ERROR: BASE_API_TOKEN が未設定です。");
  process.exit(1);
}

async function main() {
const headers = { Authorization: `Bearer ${BASE_API_TOKEN}` };

const uniqueKey = "937A28F3EED10B66";
console.log("=== BASE API 実機確認 ===\n");
console.log(`対象注文: unique_key=${uniqueKey}\n`);

// --- 注文詳細取得 ---
console.log("注文詳細取得中...");
const detailRes = await fetch(`${BASE_URL}/orders/detail/${uniqueKey}`, {
  headers,
});

if (!detailRes.ok) {
  const body = await detailRes.text();
  console.error(`注文詳細取得失敗: ${detailRes.status} ${body}`);
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
  const r = order.order_receiver as Record<string, unknown>;
  console.log("  存在: YES");
  console.log(`  name  キー: ${"name"  in r ? `あり (値: ${r.name})` : "なし"}`);
  console.log(`  zip   キー: ${"zip"   in r ? `あり (値: ${r.zip})` : "なし"}`);
  console.log(
    `  address キー: ${"address" in r ? `あり (値: ${r.address})` : "なし"}`
  );
  console.log("  フルダンプ:", JSON.stringify(r, null, 2));
} else {
  console.log("  存在: NO (order_receiver フィールドなし → D案の可能性)");
  // purchaser フォールバック確認
  if ("order_purchaser" in order) {
    console.log("  order_purchaser は存在する:", JSON.stringify(order.order_purchaser, null, 2));
  }
}

// ============================================================
// C-2: shipping_fee フィールドの存在確認
// ============================================================
console.log("------------------------------------------------------------");
console.log("【C-2】shipping_fee フィールド確認");
if ("shipping_fee" in order) {
  console.log(`  存在: YES  値: ${order.shipping_fee}`);
} else {
  console.log("  存在: NO");
}

// ============================================================
// C-3: order_items[].status の確認
// ============================================================
console.log("------------------------------------------------------------");
console.log("【C-3】order_items[].status 確認");
const items = order.order_items as Record<string, unknown>[] | undefined;
if (!items || items.length === 0) {
  console.log("  order_items が空または存在しない");
} else {
  items.forEach((item, i) => {
    const hasStatus = "status" in item;
    console.log(
      `  items[${i}]  status フィールド: ${hasStatus ? `あり  値: "${item.status}"` : "なし"}`
    );
  });
}

// ============================================================
// C-4: order_items[].order_item_id の確認
// ============================================================
console.log("------------------------------------------------------------");
console.log("【C-4】order_items[].order_item_id 確認");
if (!items || items.length === 0) {
  console.log("  order_items が空または存在しない");
} else {
  items.forEach((item, i) => {
    const hasId = "order_item_id" in item;
    if (hasId) {
      const val = item.order_item_id;
      console.log(
        `  items[${i}]  order_item_id: あり  型: ${typeof val}  値: ${val}`
      );
    } else {
      console.log(`  items[${i}]  order_item_id: なし`);
    }
  });
}

// ============================================================
// C-5: 姓名順序確認（注文者 vs 配送先）
// ============================================================
console.log("------------------------------------------------------------");
console.log("【C-5】姓名順序確認");
console.log(`  対象注文: unique_key=${uniqueKey}`);
const purchaser = order as Record<string, unknown>;
const receiver  = order.order_receiver as Record<string, unknown> | undefined;
console.log(`  注文者 (order)         : last_name="${purchaser.last_name}"  first_name="${purchaser.first_name}"`);
console.log(`  配送先 (order_receiver): first_name="${receiver?.first_name}"  last_name="${receiver?.last_name}"`);
// ============================================================
// order_receiver 全フィールドダンプ
// ============================================================
console.log("------------------------------------------------------------");
console.log("【order_receiver 全フィールド】");
if (order.order_receiver != null) {
  const r = order.order_receiver as Record<string, unknown>;
  for (const [key, val] of Object.entries(r)) {
    console.log(`  ${key}: ${JSON.stringify(val)}`);
  }
} else {
  console.log("  order_receiver: null");
}
console.log("------------------------------------------------------------");
console.log("\n=== 確認完了 ===");
} // end main

main().catch((e) => { console.error(e); process.exit(1); });

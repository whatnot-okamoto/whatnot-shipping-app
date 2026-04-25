// /api/orders/init の動作確認スクリプト（unique_key ベース）
// 実行: npx tsx scripts/test-init.ts

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const VERCEL_URL = "https://whatnot-shipping-app.vercel.app";

async function main() {
  const { redis } = await import("../lib/upstash");

  // ----------------------------------------------------------------
  // 手順1: 初回 init 実行
  // ----------------------------------------------------------------
  console.log("=== 手順1: POST /api/orders/init（初回）===");
  const initRes1 = await fetch(`${VERCEL_URL}/api/orders/init`, { method: "POST" });
  const initJson1 = await initRes1.json() as {
    success?: boolean;
    status?: string;
    initialized?: number;
    skipped?: number;
    failed_unique_keys?: string[];
    warnings?: string[];
    u1Count?: number;
    u2Count?: number;
    u4Count?: number;
    error?: string;
  };
  console.log("レスポンス:", JSON.stringify(initJson1, null, 2));

  if (!initJson1.success) {
    console.error("init 失敗。以下を確認してください:");
    console.error("  failed_unique_keys:", initJson1.failed_unique_keys);
    console.error("  warnings:", initJson1.warnings);
    console.error("  error:", initJson1.error);
    process.exit(1);
  }

  // ----------------------------------------------------------------
  // 手順2: Upstash キー生成確認
  // ----------------------------------------------------------------
  console.log("\n=== 手順2: Upstash キースキャン ===");
  const u1Keys   = await redis.keys("order:*");
  const u2Keys   = await redis.keys("bundle:*");
  const u4Keys   = await redis.keys("picking:*");
  const idxKeys  = await redis.keys("index:picking:*");

  console.log(`  order:*           ${u1Keys.length}件:`, u1Keys.slice(0, 5));
  console.log(`  bundle:*          ${u2Keys.length}件:`, u2Keys.slice(0, 3));
  console.log(`  picking:*         ${u4Keys.length}件:`, u4Keys.slice(0, 5));
  console.log(`  index:picking:*   ${idxKeys.length}件:`, idxKeys.slice(0, 5));

  if (u1Keys.length === 0) {
    console.error("U1キーが存在しない。終了します。");
    process.exit(1);
  }

  // ----------------------------------------------------------------
  // 手順3: 各キーの内容確認
  // ----------------------------------------------------------------

  // --- U1 確認 ---
  const u1Key = u1Keys[0];
  const u1Raw = await redis.get(u1Key);
  const u1Data = typeof u1Raw === "string" ? JSON.parse(u1Raw) : u1Raw;
  console.log(`\n--- U1 内容確認 (${u1Key}) ---`);
  // 個人情報フィールドは型のみ表示
  console.log(JSON.stringify(u1Data, null, 2));

  const u1Ok = {
    has_unique_key:       typeof u1Data?.unique_key === "string",
    carrier_initial:      u1Data?.carrier === "sagawa" || u1Data?.carrier === "nekopos" || u1Data?.carrier === "",
    hold_flag_false:      u1Data?.hold_flag === false,
    cancelled_flag_false: u1Data?.cancelled_flag === false,
  };
  console.log("U1 フィールド検証:", u1Ok);

  // --- U2 確認 ---
  const u2Key = u2Keys[0];
  const u2Raw = await redis.get(u2Key);
  const u2Data = typeof u2Raw === "string" ? JSON.parse(u2Raw) : u2Raw;
  console.log(`\n--- U2 内容確認 (${u2Key}) ---`);
  console.log(JSON.stringify(u2Data, null, 2));

  const u2Ok = {
    has_bundle_group_id:                 typeof u2Data?.bundle_group_id === "string",
    has_order_unique_keys:               Array.isArray(u2Data?.order_unique_keys),
    has_representative_order_unique_key: typeof u2Data?.representative_order_unique_key === "string",
    bundle_enabled_true:                 u2Data?.bundle_enabled === true,
    tracking_number_empty:               u2Data?.tracking_number === "",
  };
  console.log("U2 フィールド検証:", u2Ok);

  // --- U4 確認 ---
  const u4Key = u4Keys[0];
  const u4Raw = await redis.get(u4Key);
  const u4Data = typeof u4Raw === "string" ? JSON.parse(u4Raw) : u4Raw;
  console.log(`\n--- U4 内容確認 (${u4Key}) ---`);
  console.log(JSON.stringify(u4Data, null, 2));

  const u4Ok = {
    has_order_item_id:     typeof u4Data?.order_item_id === "number",
    has_order_unique_key:  typeof u4Data?.order_unique_key === "string",
    scanned_quantity_zero: u4Data?.scanned_quantity === 0,
  };
  console.log("U4 フィールド検証:", u4Ok);

  // --- index:picking 確認 ---
  const idxKey = idxKeys[0];
  const idxRaw = await redis.get(idxKey);
  const idxData = typeof idxRaw === "string" ? JSON.parse(idxRaw) : idxRaw;
  console.log(`\n--- index:picking 内容確認 (${idxKey}) ---`);
  console.log("item_id リスト:", idxData);

  // ----------------------------------------------------------------
  // 手順4: 再実行テスト（NX 保護確認）
  // ----------------------------------------------------------------
  console.log("\n=== 手順4: POST /api/orders/init 再実行（NX 保護確認）===");
  const initRes2 = await fetch(`${VERCEL_URL}/api/orders/init`, { method: "POST" });
  const initJson2 = await initRes2.json() as typeof initJson1;
  console.log("再実行レスポンス:", JSON.stringify(initJson2, null, 2));

  // 再実行後の U1 内容確認（上書きされていないか）
  const u1AfterRaw = await redis.get(u1Key);
  const u1AfterData = typeof u1AfterRaw === "string" ? JSON.parse(u1AfterRaw) : u1AfterRaw;
  const nxPreserved =
    u1AfterData?.unique_key     === u1Data?.unique_key &&
    u1AfterData?.carrier        === u1Data?.carrier &&
    u1AfterData?.hold_flag      === u1Data?.hold_flag &&
    u1AfterData?.cancelled_flag === u1Data?.cancelled_flag;

  console.log(`\nNX 保護判定: ${nxPreserved ? "✓ 上書きされていない（NX 正常動作）" : "✗ 上書きされた（NX 未動作）"}`);
  console.log(`  初回: carrier=${u1Data?.carrier}, hold_flag=${u1Data?.hold_flag}, cancelled_flag=${u1Data?.cancelled_flag}`);
  console.log(`  再実行後: carrier=${u1AfterData?.carrier}, hold_flag=${u1AfterData?.hold_flag}, cancelled_flag=${u1AfterData?.cancelled_flag}`);

  // ----------------------------------------------------------------
  // 最終サマリ
  // ----------------------------------------------------------------
  console.log("\n=== テスト完了サマリ ===");
  const u1KeysAll  = await redis.keys("order:*");
  const u2KeysAll  = await redis.keys("bundle:*");
  const u4KeysAll  = await redis.keys("picking:*");
  const idxKeysAll = await redis.keys("index:picking:*");
  console.log(`  order:*           ${u1KeysAll.length}件`);
  console.log(`  bundle:*          ${u2KeysAll.length}件`);
  console.log(`  picking:*         ${u4KeysAll.length}件`);
  console.log(`  index:picking:*   ${idxKeysAll.length}件`);
}

main().catch((e) => { console.error(e); process.exit(1); });

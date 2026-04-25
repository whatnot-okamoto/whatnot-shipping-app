// auth:base_token 初期投入スクリプト
// 用途: Upstash に BASE API トークンを初期セット / 再投入
// 実行: npx tsx scripts/init-token.ts

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const access_token = process.env.BASE_API_TOKEN;
const refresh_token = process.env.BASE_API_REFRESH_TOKEN;

if (!access_token) {
  console.error("ERROR: BASE_API_TOKEN が未設定です。");
  process.exit(1);
}
if (!refresh_token) {
  console.error("ERROR: BASE_API_REFRESH_TOKEN が未設定です。");
  process.exit(1);
}

const expires_at = Date.now() + (3600 - 300) * 1000;

async function main() {
  // dotenv の後に動的インポート（upstash.ts が env を参照するため）
  const { redis } = await import("../lib/upstash");

  await redis.set("auth:base_token", {
    access_token,
    refresh_token,
    expires_at,
  });

  console.log("書き込み成功");
  console.log("キー: auth:base_token");
  console.log(`expires_at: ${new Date(expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

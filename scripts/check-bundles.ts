// bundle:* キー確認スクリプト（一時利用）
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const { redis } = await import("../lib/upstash");
  const all: string[] = await redis.keys("bundle:*");
  const bg = all.filter((k) => k.startsWith("bundle:bg_"));
  const uuid = all.filter((k) => !k.startsWith("bundle:bg_"));

  console.log("=== bundle:* キー集計 ===");
  console.log("全件:", all.length, "| 新方式 bg_:", bg.length, "| 旧UUID形式:", uuid.length);
  console.log("\nbg_ キー例 (5件):", bg.slice(0, 5));
  console.log("旧UUID キー例 (5件):", uuid.slice(0, 5));

  if (bg.length > 0) {
    const raw = await redis.get(bg[0]);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    console.log("\nbg_ キー内容例:", JSON.stringify(data, null, 2));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

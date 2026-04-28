// snapshot / index:orders 確認スクリプト
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const { redis } = await import("../lib/upstash");

  const snapshotKeys: string[] = await redis.keys("order_snapshot:*");
  const indexMembers: string[] = await redis.smembers("index:orders");
  const u1Keys: string[] = await redis.keys("order:*");
  const u2bgKeys: string[] = (await redis.keys("bundle:*")).filter((k: string) => k.startsWith("bundle:bg_"));

  console.log("=== Upstash キー集計 ===");
  console.log(`  order_snapshot:*  ${snapshotKeys.length}件`);
  console.log(`  index:orders      ${indexMembers.length}件（Set）`);
  console.log(`  order:*           ${u1Keys.length}件（U1）`);
  console.log(`  bundle:bg_*       ${u2bgKeys.length}件（U2新方式）`);

  // snapshot 1件の内容確認（remark は伏せる）
  if (snapshotKeys.length > 0) {
    const raw = await redis.get(snapshotKeys[0]);
    const data: Record<string, unknown> = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
    console.log(`\n--- snapshot 内容確認 (${snapshotKeys[0]}) ---`);
    const masked = { ...data, remark: data.remark !== "" ? "【伏せ】" : "" };
    console.log(JSON.stringify(masked, null, 2));
  }

  // index:orders の先頭5件
  console.log("\nindex:orders 先頭5件:", indexMembers.slice(0, 5));

  // U1 との件数整合
  const u1Set = new Set(u1Keys.map((k: string) => k.replace("order:", "")));
  const indexSet = new Set(indexMembers);
  const onlyInU1 = [...u1Set].filter(k => !indexSet.has(k));
  const onlyInIndex = [...indexSet].filter(k => !u1Set.has(k));
  console.log("\n=== U1 と index:orders の整合確認 ===");
  console.log(`  U1にあってindex:ordersにない件数: ${onlyInU1.length}`);
  console.log(`  index:ordersにあってU1にない件数: ${onlyInIndex.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// セッションキー確認スクリプト
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const SESSION_ID = process.argv[2] ?? "";

async function main() {
  const { redis } = await import("../lib/upstash");

  const currentPtr = await redis.get("session:current");
  console.log("session:current →", currentPtr);

  if (SESSION_ID) {
    const raw = await redis.get(`session:${SESSION_ID}`);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    console.log(`session:${SESSION_ID} →`, JSON.stringify(data, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });

// 一時確認用スクリプト。接続確認後に削除してよい。
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

try {
  await redis.set("connection_test", "ok");
  const val = await redis.get("connection_test");
  await redis.del("connection_test");
  console.log("接続成功:", val);
} catch (e) {
  console.error("接続失敗:", e.message);
  process.exit(1);
}

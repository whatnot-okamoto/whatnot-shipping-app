import { spawn } from "node:child_process";
import path from "node:path";

const env = { ...process.env };
for (const name of [
  "BASE_API_TOKEN",
  "BASE_API_REFRESH_TOKEN",
  "BASE_API_BASE_URL",
  "BASE_CHECK_ORDER_UNIQUE_KEY",
  "BASE_READONLY_ACCESS_TOKEN",
  "BASE_READONLY_CLIENT_ID",
  "BASE_READONLY_CLIENT_SECRET",
  "BASE_READONLY_REDIRECT_URI",
  "BASE_CLIENT_ID",
  "BASE_CLIENT_SECRET",
  "BASE_REDIRECT_URI",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]) {
  delete env[name];
}

Object.assign(env, {
  APP_ENVIRONMENT: "local",
  BASE_DATA_MODE: "mock",
  APP_STORE_MODE: "memory",
  ADMIN_USERNAME: "mock-admin",
  ADMIN_PASSWORD: "mock-local-only",
  NEXTAUTH_SECRET: "mock-local-nextauth-secret-not-for-shared-use",
  NEXTAUTH_URL: "http://127.0.0.1:3000",
  RECEIPT_SHARE_SECRET: "mock-local-receipt-secret-not-for-shared-use",
});

const nextBin = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);
const child = spawn(
  process.execPath,
  [nextBin, "dev", "--hostname", "127.0.0.1", "--port", "3000"],
  { env, stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

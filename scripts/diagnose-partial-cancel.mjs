import { emitKeypressEvents } from "node:readline";
import { analyzePartialCancellation } from "../lib/partial-cancel-diagnostic.ts";

const BASE_ORDER_DETAIL_URL = "https://api.thebase.in/1/orders/detail";
const REQUEST_TIMEOUT_MS = 15_000;

function stop(message) {
  console.error(`停止: ${message}`);
  process.exit(1);
}

function assertSafeEnvironment() {
  if (
    process.env.APP_ENVIRONMENT !== "development" ||
    process.env.BASE_DATA_MODE !== "readonly"
  ) {
    stop(
      "APP_ENVIRONMENT=development / BASE_DATA_MODE=readonly の明示設定が必要です。"
    );
  }
  if (process.env.BASE_API_TOKEN || process.env.BASE_API_REFRESH_TOKEN) {
    stop(
      "Production用と区別できないBASE token変数が存在します。専用Development環境を確認してください。"
    );
  }
  if (!process.env.BASE_READONLY_ACCESS_TOKEN) {
    stop("BASE_READONLY_ACCESS_TOKEN が未設定です。");
  }
}

async function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    stop("注文IDはTTYから対話入力してください。pipeや引数では受け付けません。");
  }

  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("入力を中断しました。"));
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (key?.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (text && !key?.ctrl && !key?.meta) value += text;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

function printResult(result) {
  const labels = {
    normal: "通常候補",
    partial_cancel: "一部キャンセル候補",
    full_cancel: "全体キャンセル候補",
    indeterminate: "判定不能",
    explained: "説明可能",
    unexplained_difference: "未説明差額あり",
    "8_only": "8%のみ",
    "10_only": "10%のみ",
    mixed_8_10: "8%・10%混在",
  };
  console.log("=== BASE注文詳細 read-only診断結果 ===");
  console.log(`トップレベルcancelled: ${result.topLevelCancelled}`);
  console.log(
    `商品status: ${result.knownItemStatuses.join(" / ") || "既知値なし"}`
  );
  console.log(`未知status: ${result.unknownItemStatusPresent ? "あり" : "なし"}`);
  console.log(`キャンセル候補: ${labels[result.cancellationCandidate]}`);
  console.log(
    `キャンセル商品がorder_itemsに残る: ${result.cancelledItemsRemainInOrderItems}`
  );
  console.log(`金額関係: ${labels[result.amountRelation]}`);
  console.log(`税率構成: ${labels[result.taxRateComposition]}`);
  console.log("固有情報・件数・実金額・生レスポンスは表示していません。");
}

async function main() {
  assertSafeEnvironment();
  const uniqueKey = await readHiddenLine("注文ID（非表示入力）: ");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uniqueKey)) {
    stop("注文IDの形式が不正です。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(
      `${BASE_ORDER_DETAIL_URL}/${encodeURIComponent(uniqueKey)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.BASE_READONLY_ACCESS_TOKEN}`,
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }
    );
  } catch {
    stop("注文詳細GETに失敗しました。詳細は非表示です。");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    stop(`注文詳細GETに失敗しました（HTTP ${response.status}）。`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    stop("JSONレスポンスを安全に解析できませんでした。");
  }

  try {
    printResult(analyzePartialCancellation(body?.order ?? body));
  } catch {
    stop("注文構造を判定できませんでした。生レスポンスは表示しません。");
  }
}

main().catch(() => stop("予期しないエラーで停止しました。"));

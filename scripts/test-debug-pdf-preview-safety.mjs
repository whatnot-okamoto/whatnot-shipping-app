import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const SENSITIVE_SENTINEL = "SENSITIVE_ORDER_RESPONSE_SHOULD_NOT_APPEAR";
const baseFake = await import("./fakes/workflow-base-api.ts");
const previewRoute = await import("../app/api/debug/pdf-preview/route.ts");

baseFake.setWorkflowBaseOrders([]);
baseFake.setWorkflowFetchFailureMessage(SENSITIVE_SENTINEL);
baseFake.setWorkflowFetchFailures(["FIXTURE-SENSITIVE-ORDER"]);

const captured = [];
const originalError = console.error;
console.error = (...args) => captured.push(args.map(String).join(" "));
let response;
try {
  response = await previewRoute.POST(
    new Request("http://local.test/api/debug/pdf-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unique_key: "FIXTURE-SENSITIVE-ORDER" }),
    })
  );
} finally {
  console.error = originalError;
}
assert.equal(response.status, 500);
assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(SENSITIVE_SENTINEL));
assert.doesNotMatch(captured.join("\n"), new RegExp(SENSITIVE_SENTINEL));

const pageSource = await readFile(
  new URL("../app/debug/pdf-test/page.tsx", import.meta.url),
  "utf8"
);
assert.match(pageSource, /URL\.createObjectURL/);
assert.match(pageSource, /URL\.revokeObjectURL/);
assert.doesNotMatch(pageSource, /\.download\s*=/);
assert.match(pageSource, /<iframe/);

console.log("debug PDF preview safety tests passed");

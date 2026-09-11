import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { analyzePartialCancellationV2 } from "../lib/partial-cancel-diagnostic-v2.ts";
import { readSafePartialCancelDiagnostic } from "../lib/partial-cancel-diagnostic-ui.ts";
import { partialCancelFixture } from "./fixtures/partial-cancel-diagnostic-fixtures.mjs";

const pagePath = fileURLToPath(
  new URL("../app/receipts/partial-cancel-diagnostic/page.tsx", import.meta.url)
);

const safe = analyzePartialCancellationV2(structuredClone(partialCancelFixture));
assert.deepEqual(readSafePartialCancelDiagnostic({ diagnostic: safe }), safe);
assert.equal(readSafePartialCancelDiagnostic({ diagnostic: { ...safe, outcome: "RAW_VALUE" } }), null);
const resultWithUnknownField = readSafePartialCancelDiagnostic({
  diagnostic: { ...safe, orderId: "SECRET" },
});
assert.equal(resultWithUnknownField?.outcome, safe.outcome);
assert.equal(Object.hasOwn(resultWithUnknownField ?? {}, "orderId"), false);
assert.equal(readSafePartialCancelDiagnostic({ error: "SECRET" }), null);

const source = await readFile(pagePath, "utf8");
for (const required of [
  'type="password"',
  'autoComplete="off"',
  'body: JSON.stringify({})',
  'response.status === 400',
  'if (input) input.value = ""',
  "setUsed(true)",
  "readSafePartialCancelDiagnostic",
]) {
  assert.equal(source.includes(required), true, `page safety contract missing: ${required}`);
}
for (const forbidden of ["localStorage", "sessionStorage", "console.", "URLSearchParams"] ) {
  assert.equal(source.includes(forbidden), false, `forbidden browser persistence/output: ${forbidden}`);
}

console.log("partial-cancel diagnostic page tests: PASS");

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const token = process.env.BASE_READONLY_ACCESS_TOKEN ?? "";
const environmentNames = Object.keys(process.env).sort();
const expectedEnvironmentNames = [
  "APP_ENVIRONMENT",
  "BASE_DATA_MODE",
  "BASE_READONLY_ACCESS_TOKEN",
].sort();
if (JSON.stringify(environmentNames) !== JSON.stringify(expectedEnvironmentNames)) {
  process.stderr.write("UNEXPECTED_ENVIRONMENT\n");
  process.exit(99);
}
const success = {
  schemaVersion: "partial-cancel-diagnostic/v2",
  outcome: "pass_enum_complete",
  topLevelCancelled: "null",
  knownItemStatuses: {
    ordered: "present",
    cancelled: "present",
    dispatched: "absent",
  },
  unknownItemStatus: "absent",
  cancellationCandidate: "partial_cancel",
  cancellationConsistency: "consistent",
  cancelledItemsRemainInOrderItems: "yes",
  amountPathPresence: {
    active: {
      item_total_field: "all_present",
      item_plus_option_total: "all_present",
      price_plus_options_reconstructed: "all_present",
    },
    cancelled: {
      item_total_field: "all_present",
      item_plus_option_total: "all_present",
      price_plus_options_reconstructed: "all_present",
    },
  },
  amountPathAgreement: {
    active: "all_available_paths_agree",
    cancelled: "all_available_paths_agree",
  },
  taxRateComposition: { active: "rate_10_only", cancelled: "rate_8_only" },
  shippingLineItemScope: "active_and_cancelled_items",
  adjustmentPresence: {
    discount: "present",
    coinDiscount: "present",
    adjustment: "present",
    codFee: "present",
  },
  formulaRelations: {},
};
for (const amount of [
  "item_total_field",
  "item_plus_option_total",
  "price_plus_options_reconstructed",
]) {
  for (const shipping of [
    "without_shipping",
    "order_shipping_fee",
    "all_shipping_lines",
    "active_shipping_lines_only",
    "active_item_shipping_fee",
  ]) {
    success.formulaRelations[`${amount}__${shipping}`] = "matches";
  }
}

const childErrorExitCodes = {
  STOP_RUNTIME_BOUNDARY: 21,
  STOP_INPUT: 22,
  STOP_TIMEOUT: 23,
  STOP_TRANSPORT: 24,
  STOP_HTTP: 25,
  STOP_RESPONSE_TOO_LARGE: 26,
  STOP_RESPONSE_BODY: 27,
  STOP_RESPONSE_SCHEMA: 28,
  STOP_INTERNAL: 29,
};

if (token === "success") {
  process.stdout.write(`${JSON.stringify(success)}\n`);
} else if (token === "indeterminate") {
  process.stdout.write(
    `${JSON.stringify({ ...success, outcome: "stop_indeterminate" })}\n`
  );
  process.stderr.write("STOP_ENUM_INDETERMINATE\n");
  process.exitCode = 20;
} else if (token.startsWith("child-error:")) {
  const code = token.slice("child-error:".length);
  if (Object.hasOwn(childErrorExitCodes, code)) {
    process.stderr.write(`${code}\n`);
    process.exitCode = childErrorExitCodes[code];
  } else {
    process.stderr.write("UNKNOWN_CHILD_ERROR\n");
    process.exitCode = 99;
  }
} else if (token === "extra-schema-key") {
  process.stdout.write(`${JSON.stringify({ ...success, extra: "not-allowed" })}\n`);
} else if (token === "invalid-schema-enum") {
  process.stdout.write(
    `${JSON.stringify({ ...success, cancellationCandidate: "not-an-enum" })}\n`
  );
} else if (token === "invalid-semantic-combination") {
  process.stdout.write(
    `${JSON.stringify({ ...success, unknownItemStatus: "present" })}\n`
  );
} else if (token === "mismatched-exit") {
  process.stderr.write("STOP_INPUT\n");
  process.exitCode = 23;
} else if (token === "unexpected-stdout") {
  process.stdout.write("UNSAFE_RAW_OUTPUT\n");
} else if (token === "stdout-overflow") {
  process.stdout.write("x".repeat(20_000));
} else if (token === "stderr-overflow") {
  process.stderr.write("x".repeat(1_000));
} else if (token.startsWith("watchdog:")) {
  const markerFile = Buffer.from(
    token.slice("watchdog:".length),
    "base64url"
  ).toString("utf8");
  const grandchildPath = fileURLToPath(
    new URL("./partial-cancel-launcher-grandchild.mjs", import.meta.url)
  );
  spawn(process.execPath, [grandchildPath, markerFile], {
    stdio: "ignore",
    windowsHide: true,
  });
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write("STOP_INPUT\n");
  process.exitCode = 22;
}

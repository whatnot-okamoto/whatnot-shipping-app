const CONFIRMATION_ARGUMENT = "--confirm-fixed-readonly";
const EXIT_CODES = Object.freeze({
  PASS_READONLY_BOUNDARY: 0,
  STOP_READONLY_AUTH: 30,
  STOP_READONLY_TIMEOUT: 31,
  STOP_READONLY_TRANSPORT: 32,
  STOP_READONLY_INDETERMINATE: 33,
  STOP_RUNTIME_BOUNDARY: 13,
});

async function classify() {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== CONFIRMATION_ARGUMENT
  ) {
    return "STOP_RUNTIME_BOUNDARY";
  }

  let createRedis;
  let runReadOnly;
  try {
    ({ createDevelopmentAtomicVerificationRedis: createRedis } = await import(
      "../lib/upstash.ts"
    ));
    ({ runUpstashAtomicReadOnlyBoundary: runReadOnly } = await import(
      "../lib/upstash-atomic-readonly.ts"
    ));
  } catch {
    return "STOP_RUNTIME_BOUNDARY";
  }

  let redis;
  try {
    redis = createRedis();
  } catch {
    return "STOP_RUNTIME_BOUNDARY";
  }

  try {
    return await runReadOnly(redis);
  } catch {
    return "STOP_READONLY_INDETERMINATE";
  }
}

let classification = "STOP_READONLY_INDETERMINATE";
try {
  const candidate = await classify();
  if (Object.hasOwn(EXIT_CODES, candidate)) classification = candidate;
} catch {
  classification = "STOP_READONLY_INDETERMINATE";
}

process.exitCode = EXIT_CODES[classification];
process.stdout.write(`${classification}\n`);

const CONFIRMATION_ARGUMENT = "--confirm-fixed-readonly";
const CLI_STARTED = "CLI_STARTED";
const RUNNER_STARTED = "RUNNER_STARTED";
const EXIT_CODES = Object.freeze({
  PASS_READONLY_BOUNDARY: 0,
  STOP_READONLY_AUTH: 30,
  STOP_READONLY_TIMEOUT: 31,
  STOP_READONLY_TRANSPORT: 32,
  STOP_READONLY_INDETERMINATE: 33,
  STOP_READONLY_BEFORE_FETCH: 35,
  STOP_READONLY_HTTP: 36,
  STOP_READONLY_RESPONSE_PROCESSING: 37,
});

async function classify() {
  let progress = CLI_STARTED;
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== CONFIRMATION_ARGUMENT
  ) {
    return "STOP_READONLY_BEFORE_FETCH";
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
    return "STOP_READONLY_BEFORE_FETCH";
  }

  let redis;
  try {
    redis = createRedis();
    progress = RUNNER_STARTED;
  } catch {
    return "STOP_READONLY_BEFORE_FETCH";
  }

  try {
    return await runReadOnly(redis);
  } catch {
    return progress === RUNNER_STARTED
      ? "STOP_READONLY_INDETERMINATE"
      : "STOP_READONLY_BEFORE_FETCH";
  }
}

let classification = "STOP_READONLY_BEFORE_FETCH";
try {
  const candidate = await classify();
  classification = Object.hasOwn(EXIT_CODES, candidate)
    ? candidate
    : "STOP_READONLY_INDETERMINATE";
} catch {
  classification = "STOP_READONLY_BEFORE_FETCH";
}

process.exitCode = EXIT_CODES[classification];
process.stdout.write(`${classification}\n`);

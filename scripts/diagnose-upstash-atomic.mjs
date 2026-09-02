const CONFIRMATION_ARGUMENT = "--confirm-fixed-diagnostic";
const EXIT_CODES = Object.freeze({
  PASS_ATOMIC_CONTRACT: 0,
  STOP_DIAGNOSTIC_KEYS_PRESENT: 10,
  STOP_CONTRACT_MISMATCH: 11,
  STOP_ATOMIC_INDETERMINATE: 12,
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
  let runDiagnostic;
  try {
    ({ createDevelopmentAtomicVerificationRedis: createRedis } = await import(
      "../lib/upstash.ts"
    ));
    ({ runUpstashAtomicDiagnostic: runDiagnostic } = await import(
      "../lib/upstash-atomic-diagnostic.ts"
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
    return await runDiagnostic(redis);
  } catch {
    return "STOP_ATOMIC_INDETERMINATE";
  }
}

let classification = "STOP_ATOMIC_INDETERMINATE";
try {
  const candidate = await classify();
  if (Object.hasOwn(EXIT_CODES, candidate)) classification = candidate;
} catch {
  classification = "STOP_ATOMIC_INDETERMINATE";
}

process.exitCode = EXIT_CODES[classification];
process.stdout.write(`${classification}\n`);

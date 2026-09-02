const CONFIRMATION_ARGUMENT = "--confirm-fixed-recovery";
const EXIT_CODES = Object.freeze({
  PASS_RECOVERY_COMPLETE: 0,
  STOP_RECOVERY_VALUE_UNEXPECTED: 20,
  STOP_RECOVERY_INDETERMINATE: 21,
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
  let runRecovery;
  try {
    ({ createDevelopmentAtomicVerificationRedis: createRedis } = await import(
      "../lib/upstash.ts"
    ));
    ({ runUpstashAtomicRecovery: runRecovery } = await import(
      "../lib/upstash-atomic-recovery.ts"
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
    return await runRecovery(redis);
  } catch {
    return "STOP_RECOVERY_INDETERMINATE";
  }
}

let classification = "STOP_RECOVERY_INDETERMINATE";
try {
  const candidate = await classify();
  if (Object.hasOwn(EXIT_CODES, candidate)) classification = candidate;
} catch {
  classification = "STOP_RECOVERY_INDETERMINATE";
}

process.exitCode = EXIT_CODES[classification];
process.stdout.write(`${classification}\n`);

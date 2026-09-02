const EXPECTED_ENVIRONMENT = Object.freeze({
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
  UPSTASH_REDIS_REST_URL: "https://nonsecret-import-boundary.invalid",
  UPSTASH_REDIS_REST_TOKEN: "nonsecret-import-boundary-token",
});
const UPSTASH_PACKAGE = ["@", "upstash", "/redis"].join("");

async function verifyImportBoundary() {
  const expectedNames = Object.keys(EXPECTED_ENVIRONMENT).sort();
  const actualNames = Object.keys(process.env).sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    !expectedNames.every(
      (name) => process.env[name] === EXPECTED_ENVIRONMENT[name]
    )
  ) {
    throw new Error("Fixed child environment did not match.");
  }

  const fakeModule = await import(UPSTASH_PACKAGE);
  if (fakeModule.NO_NETWORK_UPSTASH_FAKE !== true) {
    throw new Error("No-network Upstash fake was not installed.");
  }

  const upstashModule = await import("../lib/upstash.ts");
  const namespacedModule = await import("../lib/namespaced-redis.ts");
  if (
    typeof upstashModule.createDevelopmentAtomicVerificationRedis !==
    "function"
  ) {
    throw new Error("Atomic verification factory was unavailable.");
  }

  const redis = upstashModule.createDevelopmentAtomicVerificationRedis();
  namespacedModule.assertDevelopmentRedis(redis);

  const state = fakeModule.getNoNetworkUpstashFakeState();
  if (state.commandCalls !== 0 || state.constructorOptions.length !== 2) {
    throw new Error("Import fixture crossed the no-command boundary.");
  }

  const normalOptions = state.constructorOptions[0];
  const atomicOptions = state.constructorOptions[1];
  if (
    !normalOptions.hasUrl ||
    !normalOptions.hasToken ||
    normalOptions.retry !== undefined ||
    normalOptions.hasSignal ||
    !atomicOptions.hasUrl ||
    !atomicOptions.hasToken ||
    atomicOptions.retry !== false ||
    !atomicOptions.hasSignal
  ) {
    throw new Error("Atomic verification factory options did not match.");
  }
}

try {
  await verifyImportBoundary();
  process.stdout.write("UPSTASH_ATOMIC_IMPORT_BOUNDARY_OK\n");
} catch {
  process.stdout.write("STOP_RUNTIME_BOUNDARY\n");
  process.exitCode = 13;
}

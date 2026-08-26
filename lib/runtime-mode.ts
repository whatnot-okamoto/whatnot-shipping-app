export type AppEnvironment = "local" | "development" | "production";
export type BaseDataMode = "mock" | "readonly" | "production";
export type AppStoreMode = "memory" | "upstash";

export type RuntimeConfig = {
  appEnvironment: AppEnvironment;
  baseDataMode: BaseDataMode;
  appStoreMode: AppStoreMode;
};

type EnvironmentSource = Record<string, string | undefined>;

const ALLOWED_COMBINATIONS = new Set([
  "local:mock:memory",
  "development:readonly:upstash",
  "production:production:upstash",
]);

function readRequiredChoice<T extends string>(
  env: EnvironmentSource,
  name: string,
  allowed: readonly T[]
): T {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `[runtime-mode] ${name} is required. Refusing to choose an external connection mode implicitly.`
    );
  }
  if (!allowed.includes(value as T)) {
    throw new Error(
      `[runtime-mode] ${name} is invalid. Allowed values: ${allowed.join(", ")}.`
    );
  }
  return value as T;
}

export function resolveRuntimeConfig(
  env: EnvironmentSource = process.env
): RuntimeConfig {
  const appEnvironment = readRequiredChoice(env, "APP_ENVIRONMENT", [
    "local",
    "development",
    "production",
  ] as const);
  const baseDataMode = readRequiredChoice(env, "BASE_DATA_MODE", [
    "mock",
    "readonly",
    "production",
  ] as const);
  const appStoreMode = readRequiredChoice(env, "APP_STORE_MODE", [
    "memory",
    "upstash",
  ] as const);

  const combination = `${appEnvironment}:${baseDataMode}:${appStoreMode}`;
  if (!ALLOWED_COMBINATIONS.has(combination)) {
    throw new Error(
      `[runtime-mode] Unsafe mode combination (${combination}). ` +
        "Allowed combinations are local/mock/memory, development/readonly/upstash, and production/production/upstash."
    );
  }

  return { appEnvironment, baseDataMode, appStoreMode };
}

export function assertBaseRequestAllowed(
  mode: BaseDataMode,
  method: string
): void {
  const normalizedMethod = method.toUpperCase();
  if (mode === "mock") {
    throw new Error(
      "[runtime-mode] BASE network access is disabled in mock mode."
    );
  }
  if (mode === "readonly" && normalizedMethod !== "GET") {
    throw new Error(
      `[runtime-mode] BASE ${normalizedMethod} is disabled in readonly mode.`
    );
  }
}

export type AppEnvironment = "local" | "development" | "production";
export type BaseDataMode = "mock" | "readonly" | "production";
export type AppStoreMode = "memory" | "upstash";
export type VercelEnvironment = "development" | "preview" | "production";

export const DEVELOPMENT_PREVIEW_BRANCH = "codex/development";

export type RuntimeConfig = {
  appEnvironment: AppEnvironment;
  baseDataMode: BaseDataMode;
  appStoreMode: AppStoreMode;
  vercelEnvironment: VercelEnvironment | null;
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

function readOptionalChoice<T extends string>(
  env: EnvironmentSource,
  name: string,
  allowed: readonly T[]
): T | null {
  const value = env[name]?.trim();
  if (!value) return null;
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
  const vercelEnvironment = readOptionalChoice(env, "VERCEL_ENV", [
    "development",
    "preview",
    "production",
  ] as const);

  const combination = `${appEnvironment}:${baseDataMode}:${appStoreMode}`;
  if (!ALLOWED_COMBINATIONS.has(combination)) {
    throw new Error(
      `[runtime-mode] Unsafe mode combination (${combination}). ` +
        "Allowed combinations are local/mock/memory, development/readonly/upstash, and production/production/upstash."
    );
  }

  if (appEnvironment === "local" && vercelEnvironment !== null) {
    throw new Error(
      `[runtime-mode] local/mock/memory is only allowed outside Vercel. Received VERCEL_ENV=${vercelEnvironment}.`
    );
  }

  if (appEnvironment === "development") {
    if (vercelEnvironment !== "preview") {
      throw new Error(
        "[runtime-mode] development/readonly/upstash requires VERCEL_ENV=preview."
      );
    }
    const branch = env.VERCEL_GIT_COMMIT_REF?.trim();
    if (branch !== DEVELOPMENT_PREVIEW_BRANCH) {
      throw new Error(
        `[runtime-mode] Development Preview is restricted to ${DEVELOPMENT_PREVIEW_BRANCH}.`
      );
    }
  }

  if (
    appEnvironment === "production" &&
    vercelEnvironment !== "production"
  ) {
    throw new Error(
      "[runtime-mode] production/production/upstash requires VERCEL_ENV=production."
    );
  }

  return {
    appEnvironment,
    baseDataMode,
    appStoreMode,
    vercelEnvironment,
  };
}

export function isProductionRuntime(config: RuntimeConfig): boolean {
  return (
    config.appEnvironment === "production" &&
    config.baseDataMode === "production" &&
    config.appStoreMode === "upstash" &&
    config.vercelEnvironment === "production"
  );
}

export function assertProductionRuntime(
  config: RuntimeConfig,
  operation: string
): void {
  if (!isProductionRuntime(config)) {
    throw new Error(
      `[runtime-mode] ${operation} is only available in the validated Production runtime.`
    );
  }
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

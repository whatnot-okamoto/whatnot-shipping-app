export type AppEnvironment = "local" | "development" | "production";
export type BaseDataMode = "mock" | "readonly" | "production";
export type AppStoreMode = "memory" | "upstash";
export type VercelEnvironment = "development" | "preview" | "production";

export const DEVELOPMENT_PREVIEW_BRANCH = "codex/development";

const FORBIDDEN_DEVELOPMENT_ENVIRONMENT_VARIABLES = [
  "BASE_READONLY_ACCESS_TOKEN",
  "BASE_CLIENT_ID",
  "BASE_CLIENT_SECRET",
  "BASE_REDIRECT_URI",
  "BASE_API_TOKEN",
  "BASE_API_REFRESH_TOKEN",
] as const;

export type RuntimeConfig = {
  appEnvironment: AppEnvironment;
  baseDataMode: BaseDataMode;
  appStoreMode: AppStoreMode;
  vercelEnvironment: VercelEnvironment | null;
};

type EnvironmentSource = Record<string, string | undefined>;

type RuntimeIdentityResolution =
  | { kind: "resolved"; config: RuntimeConfig }
  | { kind: "configuration_invalid"; message: string };

type ChoiceResolution<T> =
  | { kind: "resolved"; value: T }
  | { kind: "configuration_invalid"; message: string };

const ALLOWED_COMBINATIONS = new Set([
  "local:mock:memory",
  "development:readonly:upstash",
  "production:production:upstash",
]);

function readRequiredChoice<T extends string>(
  env: EnvironmentSource,
  name: string,
  allowed: readonly T[]
): ChoiceResolution<T> {
  const value = env[name]?.trim();
  if (!value) {
    return {
      kind: "configuration_invalid",
      message: `[runtime-mode] ${name} is required. Refusing to choose an external connection mode implicitly.`,
    };
  }
  if (!allowed.includes(value as T)) {
    return {
      kind: "configuration_invalid",
      message: `[runtime-mode] ${name} is invalid. Allowed values: ${allowed.join(", ")}.`,
    };
  }
  return { kind: "resolved", value: value as T };
}

function readOptionalChoice<T extends string>(
  env: EnvironmentSource,
  name: string,
  allowed: readonly T[]
): ChoiceResolution<T | null> {
  const value = env[name]?.trim();
  if (!value) return { kind: "resolved", value: null };
  if (!allowed.includes(value as T)) {
    return {
      kind: "configuration_invalid",
      message: `[runtime-mode] ${name} is invalid. Allowed values: ${allowed.join(", ")}.`,
    };
  }
  return { kind: "resolved", value: value as T };
}

function resolveRuntimeIdentity(
  env: EnvironmentSource
): RuntimeIdentityResolution {
  const appEnvironmentResult = readRequiredChoice(env, "APP_ENVIRONMENT", [
    "local",
    "development",
    "production",
  ] as const);
  if (appEnvironmentResult.kind === "configuration_invalid") {
    return appEnvironmentResult;
  }

  const baseDataModeResult = readRequiredChoice(env, "BASE_DATA_MODE", [
    "mock",
    "readonly",
    "production",
  ] as const);
  if (baseDataModeResult.kind === "configuration_invalid") {
    return baseDataModeResult;
  }

  const appStoreModeResult = readRequiredChoice(env, "APP_STORE_MODE", [
    "memory",
    "upstash",
  ] as const);
  if (appStoreModeResult.kind === "configuration_invalid") {
    return appStoreModeResult;
  }

  const vercelEnvironmentResult = readOptionalChoice(env, "VERCEL_ENV", [
    "development",
    "preview",
    "production",
  ] as const);
  if (vercelEnvironmentResult.kind === "configuration_invalid") {
    return vercelEnvironmentResult;
  }

  const appEnvironment = appEnvironmentResult.value;
  const baseDataMode = baseDataModeResult.value;
  const appStoreMode = appStoreModeResult.value;
  const vercelEnvironment = vercelEnvironmentResult.value;

  const combination = `${appEnvironment}:${baseDataMode}:${appStoreMode}`;
  if (!ALLOWED_COMBINATIONS.has(combination)) {
    return {
      kind: "configuration_invalid",
      message:
        `[runtime-mode] Unsafe mode combination (${combination}). ` +
        "Allowed combinations are local/mock/memory, development/readonly/upstash, and production/production/upstash."
    };
  }

  if (appEnvironment === "local" && vercelEnvironment !== null) {
    return {
      kind: "configuration_invalid",
      message: `[runtime-mode] local/mock/memory is only allowed outside Vercel. Received VERCEL_ENV=${vercelEnvironment}.`,
    };
  }

  if (appEnvironment === "development") {
    if (vercelEnvironment !== "preview") {
      return {
        kind: "configuration_invalid",
        message:
          "[runtime-mode] development/readonly/upstash requires VERCEL_ENV=preview.",
      };
    }
    const branch = env.VERCEL_GIT_COMMIT_REF?.trim();
    if (branch !== DEVELOPMENT_PREVIEW_BRANCH) {
      return {
        kind: "configuration_invalid",
        message: `[runtime-mode] Development Preview is restricted to ${DEVELOPMENT_PREVIEW_BRANCH}.`,
      };
    }
  }

  if (
    appEnvironment === "production" &&
    vercelEnvironment !== "production"
  ) {
    return {
      kind: "configuration_invalid",
      message:
        "[runtime-mode] production/production/upstash requires VERCEL_ENV=production.",
    };
  }

  return {
    kind: "resolved",
    config: {
      appEnvironment,
      baseDataMode,
      appStoreMode,
      vercelEnvironment,
    },
  };
}

export function matchesDevelopmentPreviewRuntimeIdentity(
  env: EnvironmentSource = process.env
): boolean {
  const identity = resolveRuntimeIdentity(env);
  if (identity.kind === "configuration_invalid") return false;
  return isDevelopmentRuntime(identity.config);
}

export function resolveRuntimeConfig(
  env: EnvironmentSource = process.env
): RuntimeConfig {
  const identity = resolveRuntimeIdentity(env);
  if (identity.kind === "configuration_invalid") {
    throw new Error(identity.message);
  }

  if (identity.config.appEnvironment === "development") {
    for (const name of FORBIDDEN_DEVELOPMENT_ENVIRONMENT_VARIABLES) {
      if (env[name] !== undefined) {
        throw new Error(
          `[runtime-mode] ${name} must not be configured in the Development Preview runtime.`
        );
      }
    }
  }

  return identity.config;
}

export function isProductionRuntime(config: RuntimeConfig): boolean {
  return (
    config.appEnvironment === "production" &&
    config.baseDataMode === "production" &&
    config.appStoreMode === "upstash" &&
    config.vercelEnvironment === "production"
  );
}

export function isDevelopmentRuntime(config: RuntimeConfig): boolean {
  return (
    config.appEnvironment === "development" &&
    config.baseDataMode === "readonly" &&
    config.appStoreMode === "upstash" &&
    config.vercelEnvironment === "preview"
  );
}

export function assertDevelopmentRuntime(
  config: RuntimeConfig,
  operation: string
): void {
  if (!isDevelopmentRuntime(config)) {
    throw new Error(
      `[runtime-mode] ${operation} is only available in the validated Development Preview runtime.`
    );
  }
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

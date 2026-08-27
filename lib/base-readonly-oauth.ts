import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";
import {
  assertDevelopmentRuntime,
  DEVELOPMENT_PREVIEW_BRANCH,
  type RuntimeConfig,
} from "./runtime-mode";

const AUTHORIZE_ENDPOINT = "https://api.thebase.in/1/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.thebase.in/1/oauth/token";
const CALLBACK_PATH = "/api/base/readonly-reauth/callback";
const REQUIRED_SCOPE = "read_orders";
const TOKEN_KEY = "auth:base_readonly_token";
const REFRESH_LOCK_KEY = "auth:base_readonly_refresh_lock";
const STATE_KEY_PREFIX = "auth:base_readonly_state:";
const STATE_CLAIM_KEY_PREFIX = "auth:base_readonly_state_claim:";
const STATE_TTL_SECONDS = 5 * 60;
const STATE_CLAIM_TTL_SECONDS = 10 * 60;
const REFRESH_LOCK_TTL_SECONDS = 30;
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const TOKEN_HTTP_TIMEOUT_MS = 15_000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type ReadonlyOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type ReadonlyOAuthDependencies = {
  redis: DevelopmentRedisLike;
  runtime: RuntimeConfig;
  config: ReadonlyOAuthConfig;
  fetchFn?: FetchLike;
  now?: () => number;
  randomStateBytes?: () => Uint8Array;
};

type StateRecord = {
  version: 1;
  purpose: "base_readonly_oauth";
  appEnvironment: "development";
  vercelEnvironment: "preview";
  branch: typeof DEVELOPMENT_PREVIEW_BRANCH;
  sessionNonceHash: string;
  createdAt: number;
  expiresAt: number;
};

type ScopeVerification = "response" | "requested_and_manual_consent";

type StoredReadonlyToken = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: number;
  expectedScope: typeof REQUIRED_SCOPE;
  scopeVerification: ScopeVerification;
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopeVerification: ScopeVerification;
};

export type BaseReadonlyOAuthCallbackResult = "authorized" | "denied";

export interface BaseReadonlyOAuthModule {
  createAuthorizationUrl(input: {
    requestOrigin: string;
    sessionNonce: string;
  }): Promise<string>;
  completeCallback(input: {
    requestUrl: string;
    sessionNonce: string;
  }): Promise<BaseReadonlyOAuthCallbackResult>;
  getAccessToken(): Promise<string>;
}

export class BaseReadonlyReauthorizationRequiredError extends Error {
  readonly code = "BASE_READONLY_REAUTH_REQUIRED";

  constructor() {
    super("Development read-only BASE authorization is required.");
    this.name = "BaseReadonlyReauthorizationRequiredError";
  }
}

export class BaseReadonlyOAuthStateError extends Error {
  readonly code = "BASE_READONLY_OAUTH_STATE_INVALID";

  constructor() {
    super("Development read-only OAuth state is invalid or already used.");
    this.name = "BaseReadonlyOAuthStateError";
  }
}

export class BaseReadonlyOAuthExchangeError extends Error {
  readonly code = "BASE_READONLY_OAUTH_EXCHANGE_FAILED";

  constructor() {
    super("Development read-only OAuth token exchange failed.");
    this.name = "BaseReadonlyOAuthExchangeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashSessionNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("base64url");
}

function nonceHashesMatch(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(actual, "utf8")
    );
  } catch {
    return false;
  }
}

function validateConfig(config: ReadonlyOAuthConfig): URL {
  if (!config.clientId.trim() || !config.clientSecret) {
    throw new Error(
      "[base-readonly-oauth] Development OAuth client configuration is incomplete."
    );
  }

  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error(
      "[base-readonly-oauth] BASE_READONLY_REDIRECT_URI must be an absolute URL."
    );
  }

  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.pathname !== CALLBACK_PATH ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error(
      `[base-readonly-oauth] BASE_READONLY_REDIRECT_URI must be an HTTPS origin plus ${CALLBACK_PATH}, without credentials, query, or fragment.`
    );
  }
  return redirect;
}

function parseStateRecord(value: unknown): StateRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    value.purpose !== "base_readonly_oauth" ||
    value.appEnvironment !== "development" ||
    value.vercelEnvironment !== "preview" ||
    value.branch !== DEVELOPMENT_PREVIEW_BRANCH ||
    typeof value.sessionNonceHash !== "string" ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return null;
  }
  return value as StateRecord;
}

function parseStoredToken(value: unknown): StoredReadonlyToken | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    value.tokenType !== "Bearer" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0 ||
    value.expectedScope !== REQUIRED_SCOPE ||
    (value.scopeVerification !== "response" &&
      value.scopeVerification !== "requested_and_manual_consent")
  ) {
    return null;
  }
  return value as StoredReadonlyToken;
}

function parseTokenResponse(
  value: unknown,
  inheritedScopeVerification: ScopeVerification =
    "requested_and_manual_consent",
  isRefreshResponse = false
): TokenResponse {
  if (!isRecord(value)) throw new BaseReadonlyOAuthExchangeError();

  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const tokenType = value.token_type;
  const expiresIn = value.expires_in;
  const scope = value.scope;

  if (
    typeof refreshToken !== "string" ||
    !refreshToken.trim()
  ) {
    if (isRefreshResponse) {
      throw new BaseReadonlyReauthorizationRequiredError();
    }
    throw new BaseReadonlyOAuthExchangeError();
  }

  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    typeof tokenType !== "string" ||
    tokenType.toLowerCase() !== "bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new BaseReadonlyOAuthExchangeError();
  }

  if (scope !== undefined && scope !== REQUIRED_SCOPE) {
    throw new BaseReadonlyOAuthExchangeError();
  }

  return {
    accessToken,
    refreshToken,
    expiresIn,
    scopeVerification:
      scope === REQUIRED_SCOPE ? "response" : inheritedScopeVerification,
  };
}

function parseCallbackParameters(url: URL): {
  state: string;
  code: string | null;
  denied: boolean;
} {
  const stateValues = url.searchParams.getAll("state");
  const codeValues = url.searchParams.getAll("code");
  const errorValues = url.searchParams.getAll("error");

  if (
    stateValues.length !== 1 ||
    !stateValues[0] ||
    codeValues.length > 1 ||
    errorValues.length > 1 ||
    (codeValues.length === 1 && errorValues.length === 1) ||
    (codeValues.length === 0 && errorValues.length === 0) ||
    (codeValues.length === 1 && !codeValues[0]) ||
    (errorValues.length === 1 && !errorValues[0])
  ) {
    throw new BaseReadonlyOAuthStateError();
  }

  return {
    state: stateValues[0],
    code: codeValues.length === 1 ? codeValues[0] : null,
    denied: errorValues.length === 1,
  };
}

export function createBaseReadonlyOAuth(
  dependencies: ReadonlyOAuthDependencies
): BaseReadonlyOAuthModule {
  const { redis, runtime, config } = dependencies;
  assertDevelopmentRuntime(runtime, "Development read-only BASE OAuth");
  assertDevelopmentRedis(redis);
  const redirect = validateConfig(config);
  const fetchFn = dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? Date.now;
  const randomStateBytes =
    dependencies.randomStateBytes ?? (() => randomBytes(32));

  function assertRequestOrigin(requestOrigin: string): void {
    let origin: URL;
    try {
      origin = new URL(requestOrigin);
    } catch {
      throw new Error("[base-readonly-oauth] Request origin is invalid.");
    }
    if (
      origin.origin !== requestOrigin ||
      origin.origin !== redirect.origin ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error(
        "[base-readonly-oauth] Request origin does not match the configured Development redirect origin."
      );
    }
  }

  async function requestToken(
    params: URLSearchParams,
    inheritedScopeVerification?: ScopeVerification,
    isRefreshResponse = false
  ): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetchFn(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new BaseReadonlyOAuthExchangeError();
    }

    if (!response.ok) throw new BaseReadonlyOAuthExchangeError();

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BaseReadonlyOAuthExchangeError();
    }
    return parseTokenResponse(
      body,
      inheritedScopeVerification,
      isRefreshResponse
    );
  }

  async function saveToken(token: TokenResponse): Promise<string> {
    const nowValue = now();
    if (!Number.isSafeInteger(nowValue) || nowValue < 0) {
      throw new BaseReadonlyOAuthExchangeError();
    }
    const expiresAt = nowValue + token.expiresIn * 1000;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new BaseReadonlyOAuthExchangeError();
    }
    const stored: StoredReadonlyToken = {
      version: 1,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: "Bearer",
      expiresAt,
      expectedScope: REQUIRED_SCOPE,
      scopeVerification: token.scopeVerification,
    };
    const saved = await redis.set(TOKEN_KEY, stored);
    if (saved !== "OK") throw new BaseReadonlyOAuthExchangeError();
    return token.accessToken;
  }

  async function createAuthorizationUrl(input: {
    requestOrigin: string;
    sessionNonce: string;
  }): Promise<string> {
    assertRequestOrigin(input.requestOrigin);
    if (!input.sessionNonce) throw new BaseReadonlyOAuthStateError();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bytes = randomStateBytes();
      if (bytes.byteLength < 32) {
        throw new Error(
          "[base-readonly-oauth] OAuth state requires at least 256 bits of cryptographic randomness."
        );
      }
      const state = Buffer.from(bytes).toString("base64url");
      const createdAt = now();
      const expiresAt = createdAt + STATE_TTL_SECONDS * 1000;
      if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)) {
        throw new BaseReadonlyOAuthStateError();
      }
      const record: StateRecord = {
        version: 1,
        purpose: "base_readonly_oauth",
        appEnvironment: "development",
        vercelEnvironment: "preview",
        branch: DEVELOPMENT_PREVIEW_BRANCH,
        sessionNonceHash: hashSessionNonce(input.sessionNonce),
        createdAt,
        expiresAt,
      };
      const saved = await redis.set(`${STATE_KEY_PREFIX}${state}`, record, {
        nx: true,
        ex: STATE_TTL_SECONDS,
      });
      if (saved) {
        const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", config.clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirect.href);
        authorizeUrl.searchParams.set("scope", REQUIRED_SCOPE);
        authorizeUrl.searchParams.set("state", state);
        return authorizeUrl.href;
      }
    }
    throw new BaseReadonlyOAuthStateError();
  }

  async function completeCallback(input: {
    requestUrl: string;
    sessionNonce: string;
  }): Promise<BaseReadonlyOAuthCallbackResult> {
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(input.requestUrl);
    } catch {
      throw new BaseReadonlyOAuthStateError();
    }
    if (
      callbackUrl.origin !== redirect.origin ||
      callbackUrl.pathname !== redirect.pathname ||
      callbackUrl.username ||
      callbackUrl.password ||
      callbackUrl.hash
    ) {
      throw new BaseReadonlyOAuthStateError();
    }

    const callback = parseCallbackParameters(callbackUrl);
    const stateKey = `${STATE_KEY_PREFIX}${callback.state}`;
    const stateRecord = parseStateRecord(await redis.get(stateKey));
    const nowValue = now();
    const nonceHash = hashSessionNonce(input.sessionNonce);
    if (
      !stateRecord ||
      stateRecord.createdAt > nowValue ||
      stateRecord.expiresAt <= nowValue ||
      !nonceHashesMatch(stateRecord.sessionNonceHash, nonceHash)
    ) {
      throw new BaseReadonlyOAuthStateError();
    }

    const claimed = await redis.set(
      `${STATE_CLAIM_KEY_PREFIX}${callback.state}`,
      "1",
      { nx: true, ex: STATE_CLAIM_TTL_SECONDS }
    );
    if (!claimed) throw new BaseReadonlyOAuthStateError();

    await redis.del(stateKey);
    if (callback.denied) return "denied";

    const token = await requestToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code!,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirect.href,
      })
    );
    await saveToken(token);
    return "authorized";
  }

  async function getAccessToken(): Promise<string> {
    const stored = parseStoredToken(await redis.get(TOKEN_KEY));
    if (!stored) throw new BaseReadonlyReauthorizationRequiredError();

    if (stored.expiresAt > now() + TOKEN_EXPIRY_MARGIN_SECONDS * 1000) {
      return stored.accessToken;
    }

    const lockAcquired = await redis.set(REFRESH_LOCK_KEY, "1", {
      nx: true,
      ex: REFRESH_LOCK_TTL_SECONDS,
    });
    if (!lockAcquired) {
      const updated = parseStoredToken(await redis.get(TOKEN_KEY));
      if (
        updated &&
        updated.expiresAt > now() + TOKEN_EXPIRY_MARGIN_SECONDS * 1000
      ) {
        return updated.accessToken;
      }
      throw new BaseReadonlyOAuthExchangeError();
    }

    try {
      const token = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: stored.refreshToken,
          redirect_uri: redirect.href,
        }),
        stored.scopeVerification,
        true
      );
      return await saveToken(token);
    } finally {
      await redis.del(REFRESH_LOCK_KEY);
    }
  }

  return { createAuthorizationUrl, completeCallback, getAccessToken };
}

export const BASE_READONLY_OAUTH_CALLBACK_PATH = CALLBACK_PATH;

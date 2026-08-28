import type { BaseReadonlyOAuthModule } from "./base-readonly-oauth";

const DEVELOPMENT_GET_TIMEOUT_MS = 30_000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class BaseReadonlyApiRequestError extends Error {
  readonly code = "BASE_READONLY_API_REQUEST_FAILED";

  constructor() {
    super("Development read-only BASE request failed.");
    this.name = "BaseReadonlyApiRequestError";
  }
}

export async function fetchDevelopmentBaseJson<T>(input: {
  oauth: BaseReadonlyOAuthModule;
  url: string;
  fetchFn?: FetchLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<T> {
  const fetchFn = input.fetchFn ?? fetch;
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const grant = await input.oauth.getAccessGrant();
  const controller = new AbortController();
  const timeout = setTimeoutFn(
    () => controller.abort(),
    DEVELOPMENT_GET_TIMEOUT_MS
  );

  try {
    // The same opaque grant captured during token acquisition is checked at
    // the last application-controlled boundary before the business GET.
    const token = await input.oauth.authorizeAccessGrant(grant);
    const response = await fetchFn(input.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      // Keep the timeout active through error body consumption, but never
      // surface or log that body.
      await response.text();
      throw new BaseReadonlyApiRequestError();
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof BaseReadonlyApiRequestError) throw error;
    throw new BaseReadonlyApiRequestError();
  } finally {
    clearTimeoutFn(timeout);
  }
}

export const BASE_READONLY_GET_TIMEOUT_MS = DEVELOPMENT_GET_TIMEOUT_MS;

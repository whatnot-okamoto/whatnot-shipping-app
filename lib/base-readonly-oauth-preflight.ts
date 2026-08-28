import { matchesDevelopmentPreviewRuntimeIdentity } from "./runtime-mode";

const BASE_READONLY_OAUTH_CONFIG_NAMES = [
  "BASE_READONLY_CLIENT_ID",
  "BASE_READONLY_CLIENT_SECRET",
  "BASE_READONLY_REDIRECT_URI",
  "BASE_READONLY_ACCESS_TOKEN",
] as const;

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
} as const;

const RESPONSE_CONTRACT = {
  NOT_FOUND: { status: 404, bodyStatus: null },
  UNAUTHORIZED: { status: 401, bodyStatus: "UNAUTHORIZED" },
  ABSENT: { status: 200, bodyStatus: "ABSENT" },
  PRESENT_STOP: { status: 409, bodyStatus: "PRESENT_STOP" },
  INTERNAL_ERROR: { status: 500, bodyStatus: "INTERNAL_ERROR" },
} as const;

type PreflightResponseKind = keyof typeof RESPONSE_CONTRACT;
type EnvironmentSource = Record<string, string | undefined>;

type PreflightDependencies = {
  request: Request;
  env?: EnvironmentSource;
  requireAuthenticated: (request?: Request) => Promise<Response | null>;
};

function createPreflightResponse(kind: PreflightResponseKind): Response {
  const contract = RESPONSE_CONTRACT[kind];
  const body =
    contract.bodyStatus === null
      ? null
      : JSON.stringify({ status: contract.bodyStatus });

  return new Response(body, {
    status: contract.status,
    headers:
      body === null
        ? RESPONSE_HEADERS
        : { ...RESPONSE_HEADERS, "Content-Type": "application/json" },
  });
}

function hasBaseReadonlyOAuthConfig(env: EnvironmentSource): boolean {
  return BASE_READONLY_OAUTH_CONFIG_NAMES.some((name) =>
    Object.hasOwn(env, name)
  );
}

export async function handleBaseReadonlyOAuthPreflight({
  request,
  env = process.env,
  requireAuthenticated,
}: PreflightDependencies): Promise<Response> {
  try {
    if (!matchesDevelopmentPreviewRuntimeIdentity(env)) {
      return createPreflightResponse("NOT_FOUND");
    }

    const authenticationFailure = await requireAuthenticated(request);
    if (authenticationFailure !== null) {
      return createPreflightResponse("UNAUTHORIZED");
    }

    return createPreflightResponse(
      hasBaseReadonlyOAuthConfig(env) ? "PRESENT_STOP" : "ABSENT"
    );
  } catch {
    return createPreflightResponse("INTERNAL_ERROR");
  }
}

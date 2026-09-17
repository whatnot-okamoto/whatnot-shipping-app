let authResponse: Response | null = null;

export function setWorkflowAuthResponse(response: Response | null): void {
  authResponse = response;
}

export async function requireAuth(): Promise<Response | null> {
  return authResponse?.clone() ?? null;
}

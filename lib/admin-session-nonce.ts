import { randomBytes } from "node:crypto";

export const ADMIN_SESSION_NONCE_CLAIM = "adminSessionNonce";

export type AdminSessionJwt = Record<string, unknown> & {
  [ADMIN_SESSION_NONCE_CLAIM]?: unknown;
};

export function updateAdminSessionNonce<T extends AdminSessionJwt>(
  token: T,
  isInitialSignIn: boolean,
  createNonce: () => string = () => randomBytes(32).toString("base64url")
): T {
  if (isInitialSignIn) {
    token[ADMIN_SESSION_NONCE_CLAIM] = createNonce();
  }
  return token;
}

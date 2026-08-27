import type { NextAuthOptions } from "next-auth";
import { getToken } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import { getServerSession } from "next-auth/next";
import { NextResponse, type NextRequest } from "next/server";
import {
  ADMIN_SESSION_NONCE_CLAIM,
  type AdminSessionJwt,
  updateAdminSessionNonce,
} from "./admin-session-nonce";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const adminUsername = process.env.ADMIN_USERNAME;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminUsername || !adminPassword) {
          console.error("[auth] ADMIN_USERNAME or ADMIN_PASSWORD is not set");
          return null;
        }

        if (
          credentials?.username === adminUsername &&
          credentials?.password === adminPassword
        ) {
          return { id: "admin", name: "admin" };
        }

        return null;
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token, user }) {
      return updateAdminSessionNonce(token, Boolean(user));
    },
    async session({ session }) {
      // nonceは暗号化済みHttpOnly JWT内だけに保持し、session JSONへ転記しない。
      return session;
    },
  },
};

export async function getAdminSessionNonce(
  request: NextRequest
): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const token = (await getToken({ req: request, secret })) as AdminSessionJwt | null;
  const nonce = token?.[ADMIN_SESSION_NONCE_CLAIM];
  return typeof nonce === "string" && nonce.length >= 32 ? nonce : null;
}

export async function requireAuth(
  request?: Request
): Promise<NextResponse | null> {
  void request;
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  return null;
}

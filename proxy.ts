import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(req: NextRequest) {
  const token = await getToken({ req });

  if (!token) {
    const { pathname } = req.nextUrl;
    const isApiRoute =
      pathname.startsWith("/api/orders") ||
      pathname.startsWith("/api/session");

    if (isApiRoute) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/orders/:path*",
    "/orders",
    "/api/orders/:path*",
    "/api/session/:path*",
  ],
};

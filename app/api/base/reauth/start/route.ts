import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  const clientId = process.env.BASE_CLIENT_ID;
  const redirectUri = process.env.BASE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "環境変数未設定" }, { status: 500 });
  }

  const state = crypto.randomUUID();
  await redis.set(`auth:base_reauth_state:${state}`, "1", { nx: true, ex: 600 });

  const authUrl =
    `https://api.thebase.in/1/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=read_orders+write_orders` +
    `&state=${encodeURIComponent(state)}`;

  return NextResponse.redirect(authUrl, 302);
}

import { redirect } from "next/navigation";
import { redis } from "@/lib/upstash";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseError = url.searchParams.get("error");

  if (!state || !code || baseError) {
    redirect("/orders/reauth?error=state_mismatch");
  }

  const stored = await redis.get(`auth:base_reauth_state:${state}`);
  if (!stored) {
    redirect("/orders/reauth?error=state_mismatch");
  }

  await redis.del(`auth:base_reauth_state:${state}`);

  const clientId = process.env.BASE_CLIENT_ID;
  const clientSecret = process.env.BASE_CLIENT_SECRET;
  const redirectUri = process.env.BASE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    redirect("/orders/reauth?error=token_exchange_failed");
  }

  type TokenData = { access_token: string; refresh_token: string; expires_in: number };
  let tokenData: TokenData | null = null;
  let tokenError = false;

  try {
    const tokenRes = await fetch("https://api.thebase.in/1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      tokenError = true;
    } else {
      tokenData = (await tokenRes.json()) as TokenData;
    }
  } catch {
    tokenError = true;
  }

  if (tokenError || !tokenData) {
    redirect("/orders/reauth?error=token_exchange_failed");
  }

  const { access_token, refresh_token, expires_in } = tokenData!;
  if (!access_token || !refresh_token) {
    redirect("/orders/reauth?error=token_exchange_failed");
  }

  const expires_at = Date.now() + (expires_in - 300) * 1000;

  let saveError = false;
  try {
    await redis.set("auth:base_token", JSON.stringify({ access_token, refresh_token, expires_at }));
  } catch {
    saveError = true;
  }

  if (saveError) {
    redirect("/orders/reauth?error=save_failed");
  }

  redirect("/orders/reauth?success=true");
}

import { notFound } from "next/navigation";
import { matchesDevelopmentPreviewRuntimeIdentity } from "@/lib/runtime-mode";
import { PreflightLoginForm } from "./preflight-login-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function DevelopmentPreflightLoginPage() {
  if (!matchesDevelopmentPreviewRuntimeIdentity(process.env)) {
    notFound();
  }

  return <PreflightLoginForm />;
}

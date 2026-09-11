import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const redirects = new Map([
  ["@/lib/auth", "scripts/fakes/workflow-auth.ts"],
  ["@/lib/base-api", "scripts/fakes/workflow-base-api.ts"],
  ["@/lib/pdf-generator", "scripts/fakes/workflow-pdf-generator.ts"],
  ["@/lib/receipt-share-token", "scripts/fakes/workflow-receipt-share-token.ts"],
]);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }
  const redirected = redirects.get(specifier);
  if (redirected) {
    return nextResolve(pathToFileURL(path.join(projectRoot, redirected)).href, context);
  }
  if (specifier.startsWith("@/")) {
    const absolute = path.join(projectRoot, specifier.slice(2));
    return nextResolve(pathToFileURL(path.extname(absolute) ? absolute : `${absolute}.ts`).href, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !isRelative || path.extname(specifier)) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}

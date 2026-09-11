import path from "node:path";
import { pathToFileURL } from "node:url";

export function createWorkflowRouteResolver(projectRoot, redirects) {
  return async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    const redirected = redirects.get(specifier);
    if (redirected) {
      return nextResolve(
        pathToFileURL(path.join(projectRoot, redirected)).href,
        context
      );
    }
    if (specifier.startsWith("@/")) {
      const absolute = path.join(projectRoot, specifier.slice(2));
      return nextResolve(
        pathToFileURL(path.extname(absolute) ? absolute : `${absolute}.ts`).href,
        context
      );
    }
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      if (
        error?.code !== "ERR_MODULE_NOT_FOUND" ||
        !isRelative ||
        path.extname(specifier)
      ) {
        throw error;
      }
      return nextResolve(`${specifier}.ts`, context);
    }
  };
}

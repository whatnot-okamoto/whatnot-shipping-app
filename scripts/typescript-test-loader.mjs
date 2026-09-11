import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const absolute = path.join(projectRoot, specifier.slice(2));
    const candidate = path.extname(absolute) ? absolute : `${absolute}.ts`;
    return nextResolve(pathToFileURL(candidate).href, context);
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
}

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const absolutePath = path.join(repositoryRoot, specifier.slice(2));
    const candidates = path.extname(absolutePath)
      ? [absolutePath]
      : [`${absolutePath}.ts`, `${absolutePath}.tsx`, `${absolutePath}.js`];
    let lastError;
    for (const candidate of candidates) {
      try {
        return await nextResolve(pathToFileURL(candidate).href, context);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
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

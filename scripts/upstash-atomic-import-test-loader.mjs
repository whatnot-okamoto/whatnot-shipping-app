const UPSTASH_PACKAGE = ["@", "upstash", "/redis"].join("");
const FAKE_MODULE_URL = new URL(
  "./upstash-atomic-no-network-fake.mjs",
  import.meta.url
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === UPSTASH_PACKAGE) {
    return { url: FAKE_MODULE_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

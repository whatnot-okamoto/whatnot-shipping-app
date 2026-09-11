import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runnerSource = await readFile(
  new URL("./run-isolated-production-build.mjs", import.meta.url),
  "utf8"
);

assert.match(
  runnerSource,
  /const topLevelFiles = new Set\(\[[\s\S]*?"proxy\.ts"[\s\S]*?\]\);/u,
  "isolated production build must copy the root proxy.ts explicitly"
);
assert.match(
  runnerSource,
  /candidate_proxy_files=/u,
  "isolated production build must report its fixed proxy.ts count"
);
assert.match(
  runnerSource,
  /leaf\.startsWith\("\.env"\)/u,
  "isolated production build must exclude .env-like files before copying"
);
assert.match(
  runnerSource,
  /envLikeFiles\.length > 0/u,
  "isolated production build must stop if an .env-like file is present"
);

console.log("isolated production build contract tests passed");

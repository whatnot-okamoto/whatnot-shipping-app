import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const runRoot = process.argv[2];
if (!runRoot || !path.isAbsolute(runRoot)) {
  throw new Error("absolute isolated run root is required");
}

const candidateDirectoryName = process.argv[3] ?? "candidate-source";
if (!/^candidate-source(?:-[a-z0-9-]+)?$/u.test(candidateDirectoryName)) {
  throw new Error("candidate source directory name is outside the allowed pattern");
}
const candidateRoot = path.join(runRoot, candidateDirectoryName);
try {
  lstatSync(candidateRoot);
  throw new Error("candidate-source already exists; refusing to overwrite it");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
mkdirSync(candidateRoot, { recursive: true });

const topLevelFiles = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next-env.d.ts",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "postcss.config.mjs",
  "postcss.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
]);
const listing = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: appRoot, encoding: "utf8", windowsHide: true }
);
if (listing.status !== 0) {
  throw new Error("could not enumerate isolated build source files");
}

let copiedFiles = 0;
for (const relative of listing.stdout.split(/\r?\n/u).filter(Boolean)) {
  const normalized = relative.replaceAll("\\", "/");
  const leaf = path.posix.basename(normalized);
  if (leaf.startsWith(".env")) continue;
  const allowed =
    normalized.startsWith("app/") ||
    normalized.startsWith("lib/") ||
    normalized.startsWith("public/") ||
    topLevelFiles.has(normalized);
  if (!allowed) continue;
  const source = path.join(appRoot, relative);
  const destination = path.join(candidateRoot, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  copiedFiles += 1;
}

function findEnvLikeFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findEnvLikeFiles(absolute));
    else if (entry.name.startsWith(".env")) found.push(absolute);
  }
  return found;
}

const envLikeFiles = findEnvLikeFiles(candidateRoot);
if (envLikeFiles.length > 0) {
  throw new Error("isolated source unexpectedly contains .env-like files");
}

const expectedNodeModules = path.join(appRoot, "node_modules");
if (!lstatSync(expectedNodeModules).isDirectory()) {
  throw new Error("App node_modules is not an existing directory");
}
const nodeModulesTarget = realpathSync(expectedNodeModules);
console.log(`verified_node_modules_target=${nodeModulesTarget}`);
console.log(`candidate_env_like_files=${envLikeFiles.length}`);
console.log(`candidate_copied_files=${copiedFiles}`);

const candidateNodeModules = path.join(candidateRoot, "node_modules");
symlinkSync(nodeModulesTarget, candidateNodeModules, "junction");

const minimalEnvironment = {
  PATH: process.env.PATH ?? "",
  Path: process.env.Path ?? process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
  PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  TEMP: process.env.TEMP ?? "",
  TMP: process.env.TMP ?? "",
  NODE_ENV: "production",
  APP_ENVIRONMENT: "local",
  BASE_DATA_MODE: "mock",
  APP_STORE_MODE: "memory",
  ADMIN_USERNAME: "mock-admin",
  ADMIN_PASSWORD: "mock-local-only",
  NEXTAUTH_SECRET: "mock-local-nextauth-secret-not-for-shared-use",
  NEXTAUTH_URL: "http://127.0.0.1:3000",
  RECEIPT_SHARE_SECRET: "mock-local-receipt-secret-not-for-shared-use",
  NEXT_TELEMETRY_DISABLED: "1",
};
const nextBin = path.join(candidateNodeModules, "next", "dist", "bin", "next");
// Turbopackは隔離root外を指すdependency junctionを拒否するため、
// この.env非同梱buildに限って明示的にWebpackを使用する。
const build = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  cwd: candidateRoot,
  env: minimalEnvironment,
  encoding: "utf8",
  stdio: "inherit",
  windowsHide: true,
});
if (build.error) throw build.error;
if (build.status !== 0) {
  throw new Error(`isolated production build failed with exit ${build.status}`);
}
console.log(`isolated_build_output=${path.join(candidateRoot, ".next")}`);

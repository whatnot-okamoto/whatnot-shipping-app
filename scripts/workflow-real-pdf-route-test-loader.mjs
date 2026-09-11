import path from "node:path";
import { createWorkflowRouteResolver } from "./workflow-route-loader-common.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const redirects = new Map([
  ["@/lib/auth", "scripts/fakes/workflow-auth.ts"],
  ["@/lib/base-api", "scripts/fakes/workflow-base-api.ts"],
]);

export const resolve = createWorkflowRouteResolver(projectRoot, redirects);

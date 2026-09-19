import { requireAuth } from './auth';
import { isProductionRuntime, resolveRuntimeConfig } from './runtime-mode';
import { createProductionPreflight, EXPECTED_FINGERPRINT } from './m1-production-preflight';

export const m1Preflight = createProductionPreflight({
  expectedFingerprint: EXPECTED_FINGERPRINT,
  requireAuth,
  production: () => isProductionRuntime(resolveRuntimeConfig()),
  // Non-secret UTC start/end window, at most 30 minutes. Missing means disabled.
  window: () => process.env.M1_PREFLIGHT_WINDOW_UTC,
  origin: () => process.env.NEXTAUTH_URL,
  reader: async signal => (await import('./upstash')).createM1ProductionReader(signal),
});

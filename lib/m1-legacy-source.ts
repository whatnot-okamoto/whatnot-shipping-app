/** Shared with the one-time migration; preserve the historical minimal schema. */
export function validateLegacySource(raw: string): void {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).refetch_done_flag === 'boolean' &&
        typeof (value as Record<string, unknown>).diff_confirmed_flag === 'boolean') return;
  } catch { /* Never propagate parser diagnostics or raw source. */ }
  throw new Error('M1_MIGRATION_SOURCE_SCHEMA');
}

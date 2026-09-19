// One-time operator CLI. NEVER run against an actual service during local development.
// Invoke with the existing typescript-test-loader. No dotenv, default endpoint, or credential fallback.
import { randomUUID } from 'node:crypto';
import { validateMigrationResult } from './migrations/diff-modal-01-v1.ts';

const SAFE_ERRORS = new Set([
  'M1_CLI_COMMAND', 'M1_CLI_ARGUMENT', 'M1_CLI_EXPLICIT_TARGET_REQUIRED', 'M1_CLI_TARGET',
  'M1_CLI_CREDENTIAL_REQUIRED', 'M1_CLI_PREFLIGHT_REQUIRED', 'M1_CLI_LEASE_BUSY', 'M1_CLI_OUTPUT_INVALID',
  'M1_MIGRATION_RECORD_MISMATCH', 'M1_MIGRATION_ADOPTION_MISMATCH', 'M1_MIGRATION_SOURCE_MISSING',
  'M1_MIGRATION_SOURCE_CHANGED', 'M1_MIGRATION_SOURCE_SCHEMA', 'M1_MIGRATION_RECORD_LIMIT',
  'M1_MIGRATION_CONFLICT', 'M1_VALUE_LIMIT', 'M1_RAW_RESPONSE',
]);

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!['inspect', 'status', 'apply'].includes(command)) throw new Error('M1_CLI_COMMAND');
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--url-env', '--token-env', '--expected-fingerprint', '--drained', '--limits-verified'].includes(args[i]) ||
        !args[i + 1] || options.has(args[i])) throw new Error('M1_CLI_ARGUMENT');
    options.set(args[i], args[i + 1]);
  }
  const urlVariable = options.get('--url-env');
  const tokenVariable = options.get('--token-env');
  if (!urlVariable || !tokenVariable || !/^[A-Z][A-Z0-9_]*$/.test(urlVariable) ||
      !/^[A-Z][A-Z0-9_]*$/.test(tokenVariable) || urlVariable.trim() !== urlVariable ||
      tokenVariable.trim() !== tokenVariable || urlVariable === tokenVariable) {
    throw new Error('M1_CLI_EXPLICIT_TARGET_REQUIRED');
  }
  // Consume only the explicitly named child-process entries. Do not enumerate the environment.
  let endpoint, token;
  try { endpoint = process.env[urlVariable]; token = process.env[tokenVariable]; }
  finally { delete process.env[urlVariable]; delete process.env[tokenVariable]; }
  if (!endpoint || endpoint.trim() !== endpoint || [...endpoint].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) throw new Error('M1_CLI_TARGET');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('M1_CLI_TARGET'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('M1_CLI_TARGET');
  if (!token || !token.trim() || [...token].some(c => [0, 10, 13].includes(c.charCodeAt(0)))) throw new Error('M1_CLI_CREDENTIAL_REQUIRED');
  // Deleting env entries does not guarantee erasure of the strings used by the live adapter.
  if (command === 'apply' && (options.get('--drained') !== 'true' || options.get('--limits-verified') !== 'true' ||
      !/^[a-f0-9]{64}$/.test(options.get('--expected-fingerprint') ?? ''))) throw new Error('M1_CLI_PREFLIGHT_REQUIRED');
  // Loading the adapter must not instantiate an implicit real connection.
  process.env.APP_ENVIRONMENT = 'local'; process.env.BASE_DATA_MODE = 'mock'; process.env.APP_STORE_MODE = 'memory';
  const { createExplicitMigrationRedis } = await import('../lib/upstash.ts');
  const { inspectMigration, applyMigration } = await import('./migrations/diff-modal-01-v1.ts');
  const store = createExplicitMigrationRedis(endpoint, token);
  const status = await inspectMigration(store);
  if (command !== 'apply' || status.status === 'adopted') return status;
  const leaseKey = 'orders:workflow_operation_lease';
  const lease = JSON.stringify({ operation: 'migration-diff-modal-01-v1', owner_token: randomUUID(), cycle_id: null });
  if (await store.set(leaseKey, lease, { nx: true, ex: 90 }) !== 'OK') throw new Error('M1_CLI_LEASE_BUSY');
  try { return await applyMigration(store, { expectedFingerprint: options.get('--expected-fingerprint'), leaseValue: lease }); }
  finally { await store.compareAndDelete(leaseKey, lease); }
}

export async function runCli(argv = process.argv.slice(2), execute = main) {
  try {
    const result = validateMigrationResult(await execute(argv));
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    let code = 'M1_MIGRATION_FAILED';
    try {
      // Reading message can itself throw (accessor, Proxy, revoked Proxy).
      const message = error?.message;
      if (typeof message === 'string' && SAFE_ERRORS.has(message)) code = message;
    } catch { /* Never inspect or stringify the secondary exception. */ }
    console.error(code);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}

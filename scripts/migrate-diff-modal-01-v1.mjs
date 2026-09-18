// One-time operator CLI. NEVER run against an actual service during local development.
// Invoke with the existing typescript-test-loader. No dotenv, default endpoint, or credential fallback.
import { randomUUID } from 'node:crypto';

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!['inspect', 'status', 'apply'].includes(command)) throw new Error('M1_CLI_COMMAND');
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--url', '--token-env', '--expected-fingerprint', '--drained', '--limits-verified'].includes(args[i]) ||
        !args[i + 1] || options.has(args[i])) throw new Error('M1_CLI_ARGUMENT');
    options.set(args[i], args[i + 1]);
  }
  const endpoint = options.get('--url');
  const variable = options.get('--token-env');
  if (!endpoint || !variable || !/^[A-Z][A-Z0-9_]*$/.test(variable)) throw new Error('M1_CLI_EXPLICIT_TARGET_REQUIRED');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('M1_CLI_TARGET');
  const token = process.env[variable];
  if (!token) throw new Error('M1_CLI_CREDENTIAL_REQUIRED');
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

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^M1_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'M1_MIGRATION_FAILED');
    process.exitCode = 1;
  });
}

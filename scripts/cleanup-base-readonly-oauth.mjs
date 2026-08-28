if (process.argv.length !== 3 || process.argv[2] !== "--confirm-disabled-cleanup") {
  throw new Error("Explicit cleanup confirmation is required.");
}

const { runBaseReadonlyOAuthCleanup } = await import(
  "../lib/base-readonly-oauth-cleanup-runtime.ts"
);

const result = await runBaseReadonlyOAuthCleanup();
process.stdout.write(
  `${JSON.stringify({
    status: "disabled_and_cleaned",
    deleted: result.deleted,
    scans: result.scanCount,
  })}\n`
);

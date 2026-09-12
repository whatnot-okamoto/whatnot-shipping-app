export type DiffRecoveryStatus =
  | "fresh"
  | "resuming_partial"
  | "conflict";

export function shouldShowDiffConfirmAction(input: {
  can_confirm?: boolean;
  recovery_status?: DiffRecoveryStatus;
}): boolean {
  return input.can_confirm !== false && input.recovery_status !== "conflict";
}

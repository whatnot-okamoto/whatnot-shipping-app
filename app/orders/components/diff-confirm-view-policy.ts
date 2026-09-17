export type DiffRecoveryStatus =
  | "fresh"
  | "resuming_partial"
  | "conflict"
  | "confirmed";

export function shouldShowDiffConfirmAction(input: {
  can_confirm?: boolean;
  recovery_status?: DiffRecoveryStatus;
}): boolean {
  return input.can_confirm !== false && input.recovery_status !== "conflict";
}

export type InitializationActionView = {
  visible: boolean;
  disabled: boolean;
  label: string;
};

export function getInitializationActionView(input: {
  has_new_uninitialized?: unknown;
  can_initialize?: unknown;
  recovery_status?: unknown;
  requires_reload?: unknown;
  is_processing?: unknown;
}): InitializationActionView {
  const isSafeInitialization =
    input.has_new_uninitialized === true &&
    input.can_initialize === true &&
    input.recovery_status === "fresh";
  if (!isSafeInitialization) {
    return {
      visible: false,
      disabled: true,
      label: "初期化できない状態です",
    };
  }
  if (input.requires_reload === true) {
    return {
      visible: true,
      disabled: true,
      label: "再読み込み後に状態を確認してください",
    };
  }
  if (input.is_processing === true) {
    return { visible: true, disabled: true, label: "処理中..." };
  }
  return { visible: true, disabled: false, label: "初期化を実行する" };
}

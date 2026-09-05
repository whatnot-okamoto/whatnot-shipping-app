"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";

type Props = {
  isSaving: boolean;
  error: string | null;
  triggerRef: RefObject<HTMLInputElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function ReceiptDisableConfirmModal({
  isSaving,
  error,
  triggerRef,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const trigger = triggerRef.current;
    cancelButtonRef.current?.focus();
    return () => trigger?.focus();
  }, [triggerRef]);

  useEffect(() => {
    if (isSaving) dialogRef.current?.focus();
  }, [isSaving]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!isSaving) {
        event.preventDefault();
        onCancel();
      }
      return;
    }

    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusableElements = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");

    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;

    if (activeElement === dialog) {
      event.preventDefault();
      (event.shiftKey ? lastElement : firstElement).focus();
    } else if (
      event.shiftKey &&
      (activeElement === firstElement || !dialog.contains(activeElement))
    ) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          dialogRef.current?.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={isSaving}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 p-6"
      >
        <h2 id={titleId} className="text-base font-bold text-gray-900">
          領収書をOFFにしますか？
        </h2>
        <p id={descriptionId} className="mt-3 text-sm text-gray-700">
          入力済みの宛名と但し書きは削除されます。この操作を続けますか？
        </p>

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex gap-3 justify-end">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700
                       hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSaving}
            className="px-4 py-2 text-sm rounded bg-red-600 text-white font-medium
                       hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? "保存中..." : "OFFにして削除"}
          </button>
        </div>
      </div>
    </div>
  );
}

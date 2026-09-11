export class ReceiptShareTokenError extends Error {
  readonly code: "invalid" | "expired";
  constructor(code: "invalid" | "expired") {
    super(code);
    this.code = code;
  }
}

let createCalls = 0;

export function resetWorkflowTokenCalls(): void {
  createCalls = 0;
}

export function getWorkflowTokenCreateCalls(): number {
  return createCalls;
}

export function validateReceiptShareInput(): void {}

export function createReceiptShareToken(input: {
  uniqueKey: string;
  receiptName: string;
  receiptNote: string;
}) {
  createCalls += 1;
  return {
    token: "fixture-token",
    payload: {
      uniqueKey: input.uniqueKey,
      receiptName: input.receiptName,
      receiptNote: input.receiptNote,
      expiresAt: 4_102_444_800,
    },
  };
}

export function readReceiptShareToken() {
  return {
    uniqueKey: "TEST-PDF-ORDER",
    receiptName: "テスト宛名",
    receiptNote: "商品代として",
    expiresAt: 4_102_444_800,
  };
}

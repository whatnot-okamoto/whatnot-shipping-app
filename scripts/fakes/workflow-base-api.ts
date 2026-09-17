import type { BaseOrder, BaseOrderSummary } from "../../lib/base-api";
export {
  getReceiverName,
  getReceiverAddress,
  getReceiverZipCode,
  getReceiverPrefecture,
} from "../../lib/base-api";

let orders: BaseOrder[] = [];
const failedKeys = new Set<string>();
const stalledKeys = new Set<string>();
let fetchFailureMessage = "fixture fetch failure";
let orderListStalls = false;
let orderListCalls = 0;
let detailCalls = 0;
let detailDelayMs = 0;
let orderListGate:
  | { entered: () => void; wait: Promise<void> }
  | null = null;
let detailGate:
  | { uniqueKey: string; entered: () => void; wait: Promise<void> }
  | null = null;

function waitForAbort<T>(signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (!signal) return;
    const rejectForAbort = () =>
      reject(new DOMException("fixture request aborted", "AbortError"));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
  });
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("fixture request aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("fixture request aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export function setWorkflowBaseOrders(nextOrders: BaseOrder[]): void {
  orders = structuredClone(nextOrders);
  failedKeys.clear();
  stalledKeys.clear();
  fetchFailureMessage = "fixture fetch failure";
  orderListStalls = false;
  orderListCalls = 0;
  detailCalls = 0;
  detailDelayMs = 0;
  orderListGate = null;
  detailGate = null;
}

export function installWorkflowOrderListGate(): {
  entered: Promise<void>;
  release: () => void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  orderListGate = { entered: markEntered, wait };
  return { entered, release };
}

export function getWorkflowOrderListCallCount(): number {
  return orderListCalls;
}

export function getWorkflowDetailCallCount(): number {
  return detailCalls;
}

export function installWorkflowDetailGate(uniqueKey: string): {
  entered: Promise<void>;
  release: () => void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  detailGate = { uniqueKey, entered: markEntered, wait };
  return { entered, release };
}

export function setWorkflowOrderListStall(shouldStall: boolean): void {
  orderListStalls = shouldStall;
}

export function setWorkflowFetchFailures(uniqueKeys: string[]): void {
  failedKeys.clear();
  for (const key of uniqueKeys) failedKeys.add(key);
}

export function setWorkflowDetailStalls(uniqueKeys: string[]): void {
  stalledKeys.clear();
  for (const key of uniqueKeys) stalledKeys.add(key);
}

export function setWorkflowDetailDelay(delayMs: number): void {
  detailDelayMs = delayMs;
}

export function setWorkflowFetchFailureMessage(message: string): void {
  fetchFailureMessage = message;
}

export async function fetchOrderedOrders(options?: {
  signal?: AbortSignal;
}): Promise<BaseOrderSummary[]> {
  orderListCalls += 1;
  if (orderListGate) {
    const gate = orderListGate;
    orderListGate = null;
    gate.entered();
    await gate.wait;
  }
  if (orderListStalls) {
    return waitForAbort(options?.signal);
  }
  return orders.map((order) => ({
    unique_key: order.unique_key,
    ordered: order.ordered,
    cancelled: order.cancelled,
    dispatched: order.dispatched,
    dispatch_status: order.dispatch_status,
    payment: order.payment,
    first_name: order.first_name,
    last_name: order.last_name,
    total: order.total,
    delivery_date: null,
    delivery_time_zone: null,
    modified: order.modified,
    terminated: order.terminated,
  }));
}

export async function fetchOrderDetail(
  uniqueKey: string,
  options?: { signal?: AbortSignal }
): Promise<BaseOrder> {
  detailCalls += 1;
  if (detailDelayMs > 0) await waitForDelay(detailDelayMs, options?.signal);
  if (detailGate?.uniqueKey === uniqueKey) {
    const gate = detailGate;
    detailGate = null;
    gate.entered();
    await gate.wait;
  }
  if (stalledKeys.has(uniqueKey)) return waitForAbort(options?.signal);
  if (failedKeys.has(uniqueKey)) throw new Error(fetchFailureMessage);
  const order = orders.find((candidate) => candidate.unique_key === uniqueKey);
  if (!order) throw new Error("fixture order not found");
  return structuredClone(order);
}

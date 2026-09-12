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

export function setWorkflowBaseOrders(nextOrders: BaseOrder[]): void {
  orders = structuredClone(nextOrders);
  failedKeys.clear();
  stalledKeys.clear();
  fetchFailureMessage = "fixture fetch failure";
  orderListStalls = false;
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

export function setWorkflowFetchFailureMessage(message: string): void {
  fetchFailureMessage = message;
}

export async function fetchOrderedOrders(options?: {
  signal?: AbortSignal;
}): Promise<BaseOrderSummary[]> {
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
  if (stalledKeys.has(uniqueKey)) return waitForAbort(options?.signal);
  if (failedKeys.has(uniqueKey)) throw new Error(fetchFailureMessage);
  const order = orders.find((candidate) => candidate.unique_key === uniqueKey);
  if (!order) throw new Error("fixture order not found");
  return structuredClone(order);
}

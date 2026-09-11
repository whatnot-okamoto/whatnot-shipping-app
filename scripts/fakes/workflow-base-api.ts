import type { BaseOrder, BaseOrderSummary } from "../../lib/base-api";
export {
  getReceiverName,
  getReceiverAddress,
  getReceiverZipCode,
  getReceiverPrefecture,
} from "../../lib/base-api";

let orders: BaseOrder[] = [];
const failedKeys = new Set<string>();

export function setWorkflowBaseOrders(nextOrders: BaseOrder[]): void {
  orders = structuredClone(nextOrders);
  failedKeys.clear();
}

export function setWorkflowFetchFailures(uniqueKeys: string[]): void {
  failedKeys.clear();
  for (const key of uniqueKeys) failedKeys.add(key);
}

export async function fetchOrderedOrders(): Promise<BaseOrderSummary[]> {
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

export async function fetchOrderDetail(uniqueKey: string): Promise<BaseOrder> {
  if (failedKeys.has(uniqueKey)) throw new Error("fixture fetch failure");
  const order = orders.find((candidate) => candidate.unique_key === uniqueKey);
  if (!order) throw new Error("fixture order not found");
  return structuredClone(order);
}

// U1・U2・U4 Upstash 初期化（DATA-01 準拠）
//
// 【U3はこのファイルの対象外】
//   U3（セッション単位）はセッションロック側の責務。
//
// 【キーを跨ぐ更新の整合（DATA-01 §5）】
//   U1・U2・U4・インデックスキーの全書き込みを pipeline で 1 回の HTTP リクエストに集約する。

import { createHash } from "crypto";
import { redis } from "@/lib/upstash";
import type { BaseOrder } from "@/lib/base-api";
import {
  assessOrderForPdf,
  type CancellationState,
  type GenerationIssueCode,
} from "@/lib/pdf-order-assessment";
import { getReceiverName, getReceiverAddress, getReceiverZipCode, getReceiverPrefecture } from "@/lib/base-api";
import {
  classifyShippingMethod,
  DEFAULT_SHIPPING_METHOD_MAPPING,
  type CarrierCategory,
  type Carrier,
} from "@/lib/carrier-mapping";
import type { RedisMutation } from "@/lib/redis-like";
import {
  DIFF_CONFIRM_CHUNK_SIZE,
  fencedMutate,
  renewWorkflowLeaseIfDue,
  WorkflowLeaseLostError,
  type WorkflowLease,
} from "@/lib/workflow-operation-lease";

// ============================================================================
// Upstash 保存型定義（DATA-01 §2 保存対象の定義 準拠）
// ============================================================================

/**
 * ORDER-SNAPSHOT-01: `order_snapshot:{unique_key}` に保存するデータ。
 * BASE詳細APIから生成した表示用スナップショット。スタッフ操作値は含まない。
 * shipping_lines複数件時はhas_multiple_shipping_lines=trueで保存し、
 * shipping_method_name/shipping_fee/shipping_categoryは空にする（C-5未確認）。
 */
export type OrderSnapshot = {
  workflow_epoch?: string;
  unique_key: string;
  bundle_group_id: string;
  receiver_name: string;
  order_date: string;          // YYYY-MM-DD
  ordered_timestamp?: number;  // Unix秒。旧snapshotは未保持のため移行期間中はoptional
  shipping_method_name: string;
  shipping_fee: number;
  shipping_lines_count: number;
  has_multiple_shipping_lines: boolean;
  shipping_category: string;   // CarrierCategory or ""
  remark: string;
  item_count: number;
  items_summary: string;
  /** 現在の再取得cycleでPDF適格性を確認した場合だけ保持する。 */
  pdf_verification_cycle_id?: string;
  open_order_presence?: "present" | "not_in_open_orders";
  cancellation_state?: CancellationState;
  pdf_generation_outcome?: "eligible" | "blocked";
  pdf_issue_codes?: GenerationIssueCode[];
};

/**
 * U1: `order:{unique_key}` に保存するデータ。
 * 注文基本情報・商品明細・配送方法は BASE API から都度取得するため保存しない（DATA-01 U1）。
 */
export type U1Data = {
  unique_key: string;
  hold_flag: boolean;
  hold_reason: string;
  carrier: Carrier | "";  // "" = 未選択（non-delivery・unknown・スタッフ未選択）
  receipt_required: boolean;
  receipt_name: string;
  receipt_note: string;
  app_memo: string;
  cancelled_flag: boolean;
};

/**
 * U2: `bundle:{bundle_group_id}` に保存するデータ。
 * tracking_number は入力確定時更新（確定時更新ルール DATA-01 §3）。初期値は ""。
 */
export type U2Data = {
  bundle_group_id: string;
  order_unique_keys: string[];
  bundle_enabled: boolean;
  representative_order_unique_key: string;
  tracking_number: string;
};

/**
 * U4: `picking:{order_item_id}` に保存するデータ。
 * 識別子は order_item_id（BASE API 由来）。jan_code は識別子ではなく照合キー（DATA-01 U4）。
 * 残数・ピッキング完了状態は派生値のため保存しない（DATA-01 §2 禁止事項）。
 */
export type U4Data = {
  order_item_id: number;
  order_unique_key: string;
  jan_code: string;
  required_quantity: number;  // source: item.amount
  scanned_quantity: number;   // 初期値 0。確認ダイアログ完了時のみ更新（DATA-01 §3）
};

// ============================================================================
// 初期化処理
// ============================================================================

export type InitializeResult = {
  u1Count: number;
  u2Count: number;
  u4Count: number;
  snapshotCount: number;
  indexOrdersAdded: number;    // sadd で新規追加された unique_key の件数
  indexOrdersFailed: boolean;  // sadd が例外をスローした場合 true
  unknownMethodOrders: Array<{
    unique_key: string;
    detectedMethodNames: string[];
  }>;
};

/**
 * BASE API から取得した注文一覧をもとに U1・U2・U4 を Upstash に初期化する。
 *
 * 処理順序:
 *   1. 同梱グループを生成（U2 の単位を決定）
 *   2. pipeline に U1・U4・インデックスキー・U2の全書き込みコマンドを積む
 *   3. pipeline.exec() で一括送信（整合性担保）
 *
 * shipping_lines.length !== 1 の注文は category="unknown" として扱う。
 */
export async function initializeOrderData(
  orders: BaseOrder[],
  lease?: WorkflowLease
): Promise<InitializeResult> {
  const bundles = groupOrdersIntoU2Bundles(orders);
  const mutations: RedisMutation[] = [];
  const bundleMutations: RedisMutation[] = [];
  const enqueueSetNx = (key: string, value: unknown) => {
    mutations.push({ type: "set_nx", key, value });
  };
  const unknownMethodOrders: InitializeResult["unknownMethodOrders"] = [];
  const existingBundles = await getBundleStates([...bundles.keys()]);

  for (const [bundleGroupId, bundleOrders] of bundles) {
    // --- U2 ---
    const orderUniqueKeys = bundleOrders
      .map((o) => o.unique_key)
      .sort();
    const existingBundle = existingBundles.get(bundleGroupId);
    const mergedOrderUniqueKeys = [
      ...new Set([
        ...(existingBundle?.order_unique_keys ?? []),
        ...orderUniqueKeys,
      ]),
    ].sort();
    const u2: U2Data = existingBundle
      ? {
          ...existingBundle,
          bundle_group_id: bundleGroupId,
          order_unique_keys: mergedOrderUniqueKeys,
          representative_order_unique_key: mergedOrderUniqueKeys[0],
        }
      : {
          bundle_group_id: bundleGroupId,
          order_unique_keys: mergedOrderUniqueKeys,
          bundle_enabled: true,
          representative_order_unique_key: mergedOrderUniqueKeys[0],
          tracking_number: "",
        };
    bundleMutations.push({
      type: existingBundle ? "set" : "set_nx",
      key: `bundle:${bundleGroupId}`,
      value: JSON.stringify(u2),
    });

    for (const order of bundleOrders) {
      // shipping_lines.length === 1 のときのみ分類。0 または >1 は unknown 扱い。
      let category: CarrierCategory = "unknown";
      let detectedMethodNames: string[] = [];
      let isUnknown = true;

      if (order.shipping_lines.length === 1) {
        const classification = classifyShippingMethod(
          order.shipping_lines[0].shipping_method,
          order.shipping_lines,
          DEFAULT_SHIPPING_METHOD_MAPPING
        );
        category = classification.category;
        detectedMethodNames = classification.detectedMethodNames;
        isUnknown = classification.isUnknown;
      } else {
        // 0件または複数件: 方法名を収集してスタッフに確認させる
        detectedMethodNames = order.shipping_lines.map((l) => l.shipping_method);
      }

      if (isUnknown) {
        unknownMethodOrders.push({
          unique_key: order.unique_key,
          detectedMethodNames,
        });
      }

      // --- Snapshot（ORDER-SNAPSHOT-01）---
      const snapshot = buildOrderSnapshot(order, bundleGroupId, category);
      enqueueSetNx(`order_snapshot:${order.unique_key}`, JSON.stringify(snapshot));

      // --- U1 ---
      const u1: U1Data = {
        unique_key: order.unique_key,
        hold_flag: false,
        hold_reason: "",
        carrier: resolveInitialCarrier(category),
        receipt_required: false,
        receipt_name: "",
        receipt_note: "",
        app_memo: "",
        cancelled_flag: false,
      };
      enqueueSetNx(`order:${order.unique_key}`, JSON.stringify(u1));

      // --- U4 + インデックスキー ---
      const itemIds: number[] = [];
      for (const item of order.order_items) {
        const u4: U4Data = {
          order_item_id: item.order_item_id,
          order_unique_key: order.unique_key,
          jan_code: item.barcode,
          required_quantity: item.amount,
          scanned_quantity: 0,
        };
        enqueueSetNx(`picking:${item.order_item_id}`, JSON.stringify(u4));
        itemIds.push(item.order_item_id);
      }
      // index:picking:{unique_key}: 注文単位で U4 を引くためのインデックス（DATA-01 §5）
      enqueueSetNx(`index:picking:${order.unique_key}`, JSON.stringify(itemIds));
    }
  }

  // U1・U4・snapshotの後にU2を作成・修復する。部分処理済みの再開時は
  // 既存U2のスタッフ操作値を保持し、同じ決定論的groupの構成員だけを
  // 和集合にする。SET NXだけでは欠落した構成員を復元できないため。
  mutations.push(...bundleMutations);

  // U1・U2・U4・snapshot・インデックスキーを一括送信（整合ルール DATA-01 §5）
  if (lease) {
    for (let offset = 0; offset < mutations.length; offset += DIFF_CONFIRM_CHUNK_SIZE) {
      await renewWorkflowLeaseIfDue(lease);
      await fencedMutate(
        lease,
        mutations.slice(offset, offset + DIFF_CONFIRM_CHUNK_SIZE)
      );
    }
  } else {
    const pipe = redis.pipeline();
    for (const mutation of mutations) {
      if (mutation.type === "set_nx") {
        pipe.set(mutation.key, mutation.value, { nx: true });
      } else if (mutation.type === "set") {
        pipe.set(mutation.key, mutation.value);
      }
    }
    await pipe.exec();
  }

  // index:orders への unique_key 登録（Set形式。pipeline 外で実行し失敗を明示的に捕捉する）
  const allUniqueKeys = orders.map((o) => o.unique_key);
  let indexOrdersAdded = 0;
  let indexOrdersFailed = false;
  if (allUniqueKeys.length > 0) {
    try {
      if (lease) {
        const results = await fencedMutate(lease, [
          { type: "sadd", key: "index:orders", members: allUniqueKeys },
        ]);
        indexOrdersAdded = Number(results[0] ?? 0);
      } else {
        indexOrdersAdded = await redis.sadd(
          "index:orders",
          ...(allUniqueKeys as [string, ...string[]])
        );
      }
    } catch (error) {
      if (error instanceof WorkflowLeaseLostError) throw error;
      indexOrdersFailed = true;
    }
  }

  return {
    u1Count: orders.length,
    u2Count: bundles.size,
    u4Count: orders.reduce((sum, o) => sum + o.order_items.length, 0),
    snapshotCount: orders.length,
    indexOrdersAdded,
    indexOrdersFailed,
    unknownMethodOrders,
  };
}

// ============================================================================
// 内部ヘルパー
// ============================================================================

/**
 * 注文詳細からスナップショットを生成する（ORDER-SNAPSHOT-01準拠）。
 * shipping_lines複数件時はC-5未確認のため shipping_method_name等を空にする。
 */
function buildOrderSnapshot(
  order: BaseOrder,
  bundleGroupId: string,
  category: CarrierCategory,
  verificationCycleId?: string
): OrderSnapshot {
  const linesCount = order.shipping_lines.length;
  let shippingMethodName = "";
  let shippingFee = 0;
  let shippingCategory = "";
  let hasMultiple = false;

  if (linesCount === 1) {
    shippingMethodName = order.shipping_lines[0].shipping_method;
    shippingFee = order.shipping_lines[0].shipping_fee;
    shippingCategory = category;
  } else if (linesCount > 1) {
    hasMultiple = true;
    // shipping_method_name / shipping_fee / shipping_category は空（C-5未確認）
  }
  // linesCount === 0: すべてデフォルト値（空文字・0）

  let itemsSummary: string;
  if (order.order_items.length === 0) {
    itemsSummary = "商品情報なし";
  } else if (order.order_items.length === 1) {
    itemsSummary = order.order_items[0].title;
  } else {
    itemsSummary = `${order.order_items[0].title} 他${order.order_items.length - 1}点`;
  }

  const pdfAssessment = assessOrderForPdf(order);

  return {
    unique_key: order.unique_key,
    bundle_group_id: bundleGroupId,
    receiver_name: getReceiverName(order),
    order_date: new Date(order.ordered * 1000).toISOString().slice(0, 10),
    ordered_timestamp: order.ordered,
    shipping_method_name: shippingMethodName,
    shipping_fee: shippingFee,
    shipping_lines_count: linesCount,
    has_multiple_shipping_lines: hasMultiple,
    shipping_category: shippingCategory,
    remark: order.remark,
    item_count: order.order_items.length,
    items_summary: itemsSummary,
    ...(verificationCycleId
      ? { pdf_verification_cycle_id: verificationCycleId }
      : {}),
    open_order_presence: "present",
    cancellation_state: pdfAssessment.cancellationState,
    pdf_generation_outcome: pdfAssessment.generationOutcome,
    pdf_issue_codes: pdfAssessment.issues,
  };
}

/**
 * carrier の初期候補値を決定する。
 * スタッフの最終選択（DATA-01 U1 carrier フィールド）ではなく、U1 保存時の初期値。
 *
 * delivery     → "sagawa"（宅配系デフォルト。スタッフが S2 工程で確認・変更する）
 * nekopos      → "nekopos"（カテゴリから一意に確定）
 * non-delivery → ""（出荷対象外。carrier 選択不可）
 * unknown      → ""（マッピング未登録。スタッフが手動選択する）
 */
function resolveInitialCarrier(category: CarrierCategory): Carrier | "" {
  switch (category) {
    case "delivery":     return "sagawa";
    case "nekopos":      return "nekopos";
    case "non-delivery": return "";
    case "unknown":      return "";
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

/**
 * 同梱判定キー（注文日・氏名・郵便番号・都道府県・住所）から決定論的に bundle_group_id を生成する。
 * 同じ判定キーからは常に同じ ID が生成されるため、init 再実行時に既存 U2 を NX で保護できる（BUNDLE-ID-01）。
 * ID 形式: bg_{sha256(normalized_bundle_key).slice(0, 32)}
 */
export function generateBundleGroupId(order: BaseOrder): string {
  const date = new Date(order.ordered * 1000).toISOString().slice(0, 10);
  const name = (getReceiverName(order) ?? "").trim();
  const zip  = (getReceiverZipCode(order) ?? "").trim();
  const pref = (getReceiverPrefecture(order) ?? "").trim();
  const addr = (getReceiverAddress(order) ?? "").trim();

  const key = [date, name, zip, pref, addr].join("::");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return "bg_" + hash;
}

/**
 * 注文一覧を同梱グループ（U2 の単位）に分類する。
 *
 * グルーピング条件: 同日注文 かつ 同一顧客
 * 判定キー: 注文日 + 氏名 + 郵便番号 + 都道府県 + 住所（BUNDLE-ID-01 準拠）
 *
 * 全注文に U2 を付与する（単独注文も「1件のみの U2」として扱う）（DATA-01 U2）。
 * bundle_group_id は generateBundleGroupId() で決定論的に生成する（UUID 禁止・BUNDLE-ID-01）。
 */
function groupOrdersIntoU2Bundles(
  orders: BaseOrder[]
): Map<string, BaseOrder[]> {
  const bundles = new Map<string, BaseOrder[]>();

  for (const order of orders) {
    const bundleGroupId = generateBundleGroupId(order);
    if (!bundles.has(bundleGroupId)) {
      bundles.set(bundleGroupId, []);
    }
    bundles.get(bundleGroupId)!.push(order);
  }

  return bundles;
}

// ============================================================================
// 読み取り関数
// ============================================================================

function parseRedisValue<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

/** U1: 1件取得 */
export async function getOrderState(uniqueKey: string): Promise<U1Data | null> {
  const raw = await redis.get(`order:${uniqueKey}`);
  return parseRedisValue<U1Data>(raw);
}

/** U1: 複数件取得。存在しない unique_key はMapから除外される */
export async function getOrderStates(
  uniqueKeys: string[]
): Promise<Map<string, U1Data>> {
  if (uniqueKeys.length === 0) return new Map();
  const pipe = redis.pipeline();
  for (const key of uniqueKeys) pipe.get(`order:${key}`);
  const results = await pipe.exec();
  const map = new Map<string, U1Data>();
  uniqueKeys.forEach((key, i) => {
    const parsed = parseRedisValue<U1Data>(results[i]);
    if (parsed) map.set(key, parsed);
  });
  return map;
}

/** U2: 1件取得 */
export async function getBundleState(
  bundleGroupId: string
): Promise<U2Data | null> {
  const raw = await redis.get(`bundle:${bundleGroupId}`);
  return parseRedisValue<U2Data>(raw);
}

/** U2: 複数件取得。存在しない bundle_group_id はMapから除外される */
export async function getBundleStates(
  bundleGroupIds: string[]
): Promise<Map<string, U2Data>> {
  if (bundleGroupIds.length === 0) return new Map();
  const pipe = redis.pipeline();
  for (const id of bundleGroupIds) pipe.get(`bundle:${id}`);
  const results = await pipe.exec();
  const map = new Map<string, U2Data>();
  bundleGroupIds.forEach((id, i) => {
    const parsed = parseRedisValue<U2Data>(results[i]);
    if (parsed) map.set(id, parsed);
  });
  return map;
}

/**
 * index:ordersに存在する注文が、初期化完了に必要なU1・snapshot・U2・U4を
 * 実際に保持しているかを一括確認する。現在のinitはindex:ordersを最後に
 * 書くが、旧pipelineの個別失敗や後発欠損ではindexだけ残り得るため、
 * index単独を完了markerとして扱わない。
 */
export async function getIncompleteOrderInitializationKeys(
  uniqueKeys: string[]
): Promise<Set<string>> {
  const incomplete = new Set<string>();
  if (uniqueKeys.length === 0) return incomplete;

  const corePipe = redis.pipeline();
  for (const uniqueKey of uniqueKeys) {
    corePipe.get(`order:${uniqueKey}`);
    corePipe.get(`order_snapshot:${uniqueKey}`);
    corePipe.get(`index:picking:${uniqueKey}`);
  }
  const coreResults = await corePipe.exec();
  const completeCore: Array<{
    uniqueKey: string;
    bundleGroupId: string;
    itemIds: number[];
  }> = [];

  uniqueKeys.forEach((uniqueKey, index) => {
    const resultOffset = index * 3;
    const u1 = parseRedisValue<U1Data>(coreResults[resultOffset]);
    const snapshot = parseRedisValue<OrderSnapshot>(coreResults[resultOffset + 1]);
    const itemIds = parseRedisValue<number[]>(coreResults[resultOffset + 2]);
    if (
      !u1 ||
      !snapshot?.bundle_group_id ||
      !Array.isArray(itemIds) ||
      !itemIds.every((itemId) => Number.isSafeInteger(itemId))
    ) {
      incomplete.add(uniqueKey);
      return;
    }
    completeCore.push({
      uniqueKey,
      bundleGroupId: snapshot.bundle_group_id,
      itemIds,
    });
  });

  if (completeCore.length === 0) return incomplete;

  const relationPipe = redis.pipeline();
  for (const candidate of completeCore) {
    relationPipe.get(`bundle:${candidate.bundleGroupId}`);
    for (const itemId of candidate.itemIds) {
      relationPipe.get(`picking:${itemId}`);
    }
  }
  const relationResults = await relationPipe.exec();
  let relationOffset = 0;
  for (const candidate of completeCore) {
    const bundle = parseRedisValue<U2Data>(relationResults[relationOffset]);
    relationOffset += 1;
    const hasBundleMembership =
      bundle?.bundle_group_id === candidate.bundleGroupId &&
      Array.isArray(bundle.order_unique_keys) &&
      bundle.order_unique_keys.includes(candidate.uniqueKey);
    let hasAllU4 = true;
    for (const itemId of candidate.itemIds) {
      const u4 = parseRedisValue<U4Data>(relationResults[relationOffset]);
      relationOffset += 1;
      if (
        !u4 ||
        u4.order_item_id !== itemId ||
        u4.order_unique_key !== candidate.uniqueKey
      ) {
        hasAllU4 = false;
      }
    }
    if (!hasBundleMembership || !hasAllU4) {
      incomplete.add(candidate.uniqueKey);
    }
  }

  return incomplete;
}

/**
 * U4: 注文に紐づくピッキング進捗一覧を取得。
 * index:picking:{unique_key} → item_id リスト → 各 picking:{item_id} の順で参照する。
 */
export async function getPickingProgress(uniqueKey: string): Promise<U4Data[]> {
  const rawIndex = await redis.get(`index:picking:${uniqueKey}`);
  const itemIds = parseRedisValue<number[]>(rawIndex);
  if (!itemIds || itemIds.length === 0) return [];

  const pipe = redis.pipeline();
  for (const itemId of itemIds) pipe.get(`picking:${itemId}`);
  const results = await pipe.exec();

  return results
    .map((r) => parseRedisValue<U4Data>(r))
    .filter((d): d is U4Data => d !== null);
}

/**
 * ピッキング完了状態を派生計算する（Upstash非参照・純粋関数）。
 * この値をUpstashのキーとして保存することは禁止（DATA-01 §2 禁止事項）。
 */
export function derivePickingStatus(
  pickingItems: U4Data[]
): "completed" | "in_progress" | "not_started" {
  if (pickingItems.length === 0) return "not_started";
  if (pickingItems.every((item) => item.scanned_quantity === 0)) return "not_started";
  if (pickingItems.every((item) => item.scanned_quantity >= item.required_quantity))
    return "completed";
  return "in_progress";
}

/** Snapshot: 1件取得（ORDER-SNAPSHOT-01） */
export async function getOrderSnapshot(uniqueKey: string): Promise<OrderSnapshot | null> {
  const raw = await redis.get(`order_snapshot:${uniqueKey}`);
  return parseRedisValue<OrderSnapshot>(raw);
}

/** Snapshot: 複数件取得。存在しない unique_key はMapから除外される */
export async function getOrderSnapshots(
  uniqueKeys: string[]
): Promise<Map<string, OrderSnapshot>> {
  if (uniqueKeys.length === 0) return new Map();
  const pipe = redis.pipeline();
  for (const key of uniqueKeys) pipe.get(`order_snapshot:${key}`);
  const results = await pipe.exec();
  const map = new Map<string, OrderSnapshot>();
  uniqueKeys.forEach((key, i) => {
    const parsed = parseRedisValue<OrderSnapshot>(results[i]);
    if (parsed) map.set(key, parsed);
  });
  return map;
}

// ============================================================================
// Snapshot生成ヘルパー（refetch用）
// ============================================================================

/**
 * 注文詳細とbundle_group_idからスナップショットを生成する（refetch用）。
 * shipping_lines分類・buildOrderSnapshot相当の処理を一括で行う。
 * bundle_group_idは既存snapshotから取得して渡すこと（再計算しない）。
 */
export function buildOrderSnapshotFromDetail(
  order: BaseOrder,
  bundleGroupId: string,
  verificationCycleId?: string
): OrderSnapshot {
  let category: CarrierCategory = "unknown";
  if (order.shipping_lines.length === 1) {
    const result = classifyShippingMethod(
      order.shipping_lines[0].shipping_method,
      order.shipping_lines,
      DEFAULT_SHIPPING_METHOD_MAPPING
    );
    category = result.category;
  }
  return buildOrderSnapshot(order, bundleGroupId, category, verificationCycleId);
}

// ============================================================================
// Pending Snapshot（order_snapshot_pending）管理（Step 4-A3）
// index:order_snapshot_pending Set でKEYS命令なしに全件管理する
// ============================================================================

const PENDING_INDEX_KEY = "index:order_snapshot_pending";

/** pending Snapshot: 1件取得 */
export async function getOrderSnapshotPending(
  uniqueKey: string
): Promise<OrderSnapshot | null> {
  const raw = await redis.get(`order_snapshot_pending:${uniqueKey}`);
  return parseRedisValue<OrderSnapshot>(raw);
}

/** pending Snapshot: 1件保存。同時に index:order_snapshot_pending に SADD する */
export async function setOrderSnapshotPending(
  uniqueKey: string,
  snapshot: OrderSnapshot
): Promise<void> {
  const pipe = redis.pipeline();
  pipe.set(`order_snapshot_pending:${uniqueKey}`, JSON.stringify(snapshot));
  pipe.sadd(PENDING_INDEX_KEY, uniqueKey);
  await pipe.exec();
}

/** pending Snapshot: 複数件を1 pipelineで保存し、indexにも一括追加する */
export async function setOrderSnapshotsPending(
  snapshots: Map<string, OrderSnapshot>
): Promise<void> {
  if (snapshots.size === 0) return;
  const pipe = redis.pipeline();
  for (const [uniqueKey, snapshot] of snapshots) {
    pipe.set(`order_snapshot_pending:${uniqueKey}`, JSON.stringify(snapshot));
  }
  pipe.sadd(PENDING_INDEX_KEY, ...snapshots.keys());
  await pipe.exec();
}

/** pending Snapshot: 1件削除。同時に index:order_snapshot_pending から SREM する */
export async function deleteOrderSnapshotPending(
  uniqueKey: string
): Promise<void> {
  const pipe = redis.pipeline();
  pipe.del(`order_snapshot_pending:${uniqueKey}`);
  pipe.srem(PENDING_INDEX_KEY, uniqueKey);
  await pipe.exec();
}

/** index:order_snapshot_pending のメンバー全件を返す（KEYS命令不使用） */
export async function getAllPendingUniqueKeys(): Promise<string[]> {
  return redis.smembers(PENDING_INDEX_KEY);
}

/** pending Snapshot を全件削除し、index:order_snapshot_pending も削除する */
export async function deleteAllOrderSnapshotPending(): Promise<void> {
  const keys = await getAllPendingUniqueKeys();
  if (keys.length === 0) {
    await redis.del(PENDING_INDEX_KEY);
    return;
  }
  const pipe = redis.pipeline();
  for (const key of keys) {
    pipe.del(`order_snapshot_pending:${key}`);
  }
  pipe.del(PENDING_INDEX_KEY);
  await pipe.exec();
}

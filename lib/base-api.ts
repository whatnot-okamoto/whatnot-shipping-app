// BASE API クライアント（共通モジュール・永続）
// 注文取得・出荷完了書き戻しなど、BASE APIとの通信はすべてここ経由で行う

import { redis } from "@/lib/upstash";

const BASE_API_BASE_URL =
  process.env.BASE_API_BASE_URL ?? "https://api.thebase.in/1";

// ============================================================================
// 型定義（ORDER-FIELD-01準拠）
// ============================================================================

/**
 * 注文一覧APIのサマリー型（GET /orders レスポンス）。
 * order_items / order_receiver / shipping_lines は含まない。
 * 詳細が必要な場合は fetchOrderDetail(unique_key) を使うこと。
 */
export type BaseOrderSummary = {
  unique_key: string;
  ordered: number;            // Unix秒
  cancelled: number | null;
  dispatched: number | null;
  payment: string;
  first_name: string;
  last_name: string;
  total: number;
  delivery_date: string | null;
  delivery_time_zone: string | null;
  terminated: boolean;
  dispatch_status: string;
  modified: number;           // Unix秒
};

/**
 * 商品明細（ORDER-FIELD-01準拠）。
 * - title   : 商品名（item_title は存在しない）
 * - amount  : 数量（quantity は存在しない）
 * - order_item_ids（shipping_lines側）はstring[]のため、照合時は String(order_item_id) で変換すること
 */
export type BaseOrderItem = {
  order_item_id: number;
  item_id: number;
  variation_id: number;
  title: string;
  barcode: string;            // JANコード（スキャン照合用。識別子ではない）
  variation: string;
  variation_identifier: string;
  amount: number;
  price: number;
  status: string;             // "ordered" / "cancelled" など
};

/**
 * 配送方法情報（ORDER-FIELD-01準拠）。
 * - order_item_ids : string[]（APIがstring配列で返す。numberへの変換禁止）
 * - shipping_method: 配送方法判定の正（トップレベルのshipping_methodは常にnullのため使用禁止）
 * - shipping_fee   : 送料の正（トップレベルのshipping_feeは参照禁止）
 */
export type BaseShippingLine = {
  order_item_ids: string[];
  shipping_method: string;
  shipping_fee: number;
};

/**
 * お届け先情報（order_receiver）。
 * 実機確認（C-1）により確定したキー名を使用。
 *
 * フルネーム連結順: last_name（姓）+ first_name（名）。名→姓順の連結は禁止。
 */
export type BaseOrderReceiver = {
  last_name: string;
  first_name: string;
  zip_code: string;
  prefecture: string;
  address: string;
  address2: string;
  tel: string;
  country: string;
  country_code: string;
};

/**
 * 注文詳細型（GET /orders/detail/{unique_key} レスポンス）。
 * ORDER-FIELD-01準拠。
 *
 * shipping_method（トップレベル）は常にnullのため使用禁止。
 * 配送方法判定は shipping_lines[].shipping_method を使うこと。
 * 送料は shipping_lines[].shipping_fee を使うこと。
 */
export type BaseOrder = {
  unique_key: string;         // 注文識別子（order_id は存在しない）
  ordered: number;            // 注文日時Unix秒（ordered_at は存在しない）
  cancelled: number | null;
  dispatched: number | null;
  dispatch_status: string;
  payment: string;
  shipping_method: null;      // 常にnull。使用禁止。shipping_lines を参照すること
  shipping_fee: number;       // 存在するがcanonicalではない。shipping_lines[].shipping_fee を使うこと
  total: number;              // 注文合計金額（total_price は存在しない）
  first_name: string;         // 購入者（名）
  last_name: string;          // 購入者（姓）
  zip_code: string;
  prefecture: string;
  address: string;
  address2: string;
  tel: string;
  remark: string;
  modified: number;
  terminated: boolean;
  order_receiver: BaseOrderReceiver | null;
  order_items: BaseOrderItem[];
  shipping_lines: BaseShippingLine[];
};

type BaseOrdersApiResponse = {
  orders: BaseOrderSummary[];
};

// ============================================================================
// お届け先ヘルパー関数（DEST-01準拠）
//
// 【フォールバック発動条件（DEST-01 §5）】
//   order_receiver が null、または必須フィールドが空の場合に発動する。
//   フォールバックは注文単位で発動する。フィールド単位の混在は禁止（DEST-01 §4）。
// ============================================================================

/**
 * order_receiver が「有効」かを判定する内部ヘルパー。
 * null の場合、または last_name・first_name・zip_code・address のいずれかが空の場合は
 * フォールバックを発動する（注文単位で判定。フィールド単位の混在禁止）。
 */
function isReceiverPresent(receiver: BaseOrderReceiver | null): boolean {
  if (!receiver) return false;
  return (
    receiver.last_name.trim() !== "" &&
    receiver.first_name.trim() !== "" &&
    receiver.zip_code.trim() !== "" &&
    receiver.address.trim() !== ""
  );
}

/**
 * お届け先の氏名を返す（DEST-01 D1/D7 対応）。
 * 連結順: last_name（姓）+ first_name（名）。名→姓順の連結は禁止。
 * フォールバック: order_receiver が null またはいずれかのキーが空の場合は purchaser フィールドを使用。
 */
export function getReceiverName(order: BaseOrder): string {
  if (isReceiverPresent(order.order_receiver)) {
    const r = order.order_receiver!;
    return `${r.last_name}${r.first_name}`;
  }
  return `${order.last_name}${order.first_name}`;
}

/** @deprecated getReceiverName を使用すること */
export const getReceiverFullName = getReceiverName;

/**
 * お届け先の郵便番号を返す（DEST-01 D1/D3 対応）。
 * フォールバック: order_receiver が null または空の場合は購入者フィールドを使用。
 */
export function getReceiverZipCode(order: BaseOrder): string {
  if (isReceiverPresent(order.order_receiver)) {
    return order.order_receiver!.zip_code;
  }
  return order.zip_code;
}

/**
 * お届け先の都道府県を返す（DEST-01 D1/D7 対応）。
 * フォールバック: order_receiver が null またはいずれかのキーが空の場合は purchaser フィールドを使用。
 */
export function getReceiverPrefecture(order: BaseOrder): string {
  if (isReceiverPresent(order.order_receiver)) {
    return order.order_receiver!.prefecture;
  }
  return order.prefecture;
}

/**
 * お届け先の住所（address + address2）を返す（DEST-01 D1/D7 対応）。
 * address2 が null または空文字の場合は address のみを返す。
 * prefecture は含めない（呼び出し側で組み合わせること）。
 * フォールバック: order_receiver が null またはいずれかのキーが空の場合は purchaser フィールドを使用。
 */
export function getReceiverAddress(order: BaseOrder): string {
  if (isReceiverPresent(order.order_receiver)) {
    const r = order.order_receiver!;
    return `${r.address}${r.address2 ?? ""}`;
  }
  return `${order.address}${order.address2 ?? ""}`;
}

// ============================================================================
// BASE API トークン管理
// ============================================================================

type StoredToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

/**
 * 有効な BASE API アクセストークンを返す。
 * Upstash の auth:base_token を参照し、必要に応じて自動更新する。
 */
export async function getBaseToken(): Promise<string> {
  const stored = await redis.get<StoredToken>("auth:base_token");

  if (stored) {
    // (A) 通常運用: Upstash にトークン情報がある
    if (stored.expires_at > Date.now() + 5 * 60 * 1000) {
      return stored.access_token;
    }
    return refreshBaseToken();
  }

  // (B) 初期ブート補助：Upstashが未投入の場合のみ使用。通常運用ではUpstashが正。
  const envToken = process.env.BASE_API_TOKEN;
  if (envToken) {
    return envToken;
  }
  throw new Error("BASE API token not found: Upstash未投入かつ BASE_API_TOKEN も未設定です");
}

/**
 * Upstash の refresh_token を使って BASE API トークンを更新し、新しい access_token を返す。
 * 同時更新防止のため Redis ロック（auth:base_refresh_lock）を使用する。
 */
async function refreshBaseToken(): Promise<string> {
  const stored = await redis.get<StoredToken>("auth:base_token");
  const refresh_token = stored?.refresh_token;

  if (!refresh_token) {
    throw new Error("自動更新不能：refresh_tokenが取得できません。手動再認証が必要です");
  }

  const lockAcquired = await redis.set("auth:base_refresh_lock", "1", { nx: true, ex: 30 });

  if (lockAcquired) {
    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.BASE_CLIENT_ID ?? "",
        client_secret: process.env.BASE_CLIENT_SECRET ?? "",
        refresh_token,
        redirect_uri: process.env.BASE_REDIRECT_URI ?? "",
      });

      const res = await fetch("https://api.thebase.in/1/oauth/token", {
        method: "POST",
        body: params,
      });

      const body = await res.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };

      if (!res.ok) {
        if (body.error === "invalid_grant") {
          throw new Error("refresh_token失効。手動再認証が必要です");
        }
        throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(body)}`);
      }

      const expires_at = Date.now() + ((body.expires_in ?? 3600) - 300) * 1000;
      await redis.set("auth:base_token", {
        access_token: body.access_token!,
        refresh_token: body.refresh_token!,
        expires_at,
      });

      return body.access_token!;
    } finally {
      await redis.del("auth:base_refresh_lock");
    }
  } else {
    // 他のリクエストがrefresh中 - 最大3回待機して有効なトークンを取得する
    for (let i = 0; i < 3; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      const updated = await redis.get<StoredToken>("auth:base_token");
      if (updated && updated.expires_at > Date.now() + 5 * 60 * 1000) {
        return updated.access_token;
      }
    }
    throw new Error("token refresh wait timeout: 他リクエストによる更新完了を確認できませんでした");
  }
}

// ============================================================================
// BASE API 注文取得
// ============================================================================

/**
 * 未出荷注文の一覧（サマリー）を取得する。
 * dispatch_status: ordered の注文のみ返す。
 * order_items / order_receiver / shipping_lines は含まれない。
 * 詳細が必要な場合は fetchOrderDetail(unique_key) を呼ぶこと。
 */
export async function fetchOrderedOrders(): Promise<BaseOrderSummary[]> {
  if (!process.env.BASE_API_TOKEN) {
    // !! 開発補助用モックにフォールバック（本番経路ではない。下部コメント参照）
    return getMockOrderSummaries();
  }

  const token = await getBaseToken();
  const url = `${BASE_API_BASE_URL}/orders?dispatch_status=ordered&limit=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BASE API error: ${res.status} ${body}`);
  }

  const data: BaseOrdersApiResponse = await res.json();
  return data.orders;
}

/**
 * unique_key を使って注文詳細を1件取得する。
 * order_items / order_receiver / shipping_lines を含む完全な BaseOrder を返す。
 * 取得失敗時はエラーをスロー（呼び出し側でキャッチすること）。
 */
export async function fetchOrderDetail(uniqueKey: string): Promise<BaseOrder> {
  if (!process.env.BASE_API_TOKEN) {
    return getMockOrderDetail(uniqueKey);
  }

  const token = await getBaseToken();
  const url = `${BASE_API_BASE_URL}/orders/detail/${uniqueKey}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BASE API detail error [${uniqueKey}]: ${res.status} ${body}`);
  }

  const data = await res.json() as { order: BaseOrder };
  return data.order;
}

// ============================================================================
// 開発補助用モックデータ
//
// 用途: BASE_API_TOKEN 未設定時（ローカル開発・CI環境）の動作確認専用
// 注意: 本番相当の挙動ではない。BASE_API_TOKEN が設定されると呼び出されない。
// ============================================================================

function getMockOrderSummaries(): BaseOrderSummary[] {
  return [
    {
      unique_key: "MOCK-1001", ordered: 1745497200, cancelled: null, dispatched: null,
      payment: "creditcard", first_name: "太郎", last_name: "山田",
      total: 5500, delivery_date: null, delivery_time_zone: null,
      terminated: false, dispatch_status: "ordered", modified: 1745497200,
    },
    {
      unique_key: "MOCK-1002", ordered: 1745500800, cancelled: null, dispatched: null,
      payment: "creditcard", first_name: "花子", last_name: "鈴木",
      total: 1100, delivery_date: null, delivery_time_zone: null,
      terminated: false, dispatch_status: "ordered", modified: 1745500800,
    },
    {
      unique_key: "MOCK-1003", ordered: 1745504400, cancelled: null, dispatched: null,
      payment: "creditcard", first_name: "次郎", last_name: "佐藤",
      total: 3300, delivery_date: null, delivery_time_zone: null,
      terminated: false, dispatch_status: "ordered", modified: 1745504400,
    },
    {
      unique_key: "MOCK-1004", ordered: 1745508000, cancelled: null, dispatched: null,
      payment: "creditcard", first_name: "三郎", last_name: "田中",
      total: 2200, delivery_date: null, delivery_time_zone: null,
      terminated: false, dispatch_status: "ordered", modified: 1745508000,
    },
  ];
}

function getMockOrderDetail(uniqueKey: string): BaseOrder {
  const mockDetails: Record<string, BaseOrder> = {
    "MOCK-1001": {
      unique_key: "MOCK-1001", ordered: 1745497200, cancelled: null, dispatched: null,
      dispatch_status: "ordered", payment: "creditcard",
      shipping_method: null, shipping_fee: 770,
      total: 5500, first_name: "太郎", last_name: "山田",
      zip_code: "150-0001", prefecture: "東京都",
      address: "渋谷区神南1-1-1", address2: "", tel: "0312345678",
      remark: "", modified: 1745497200, terminated: false,
      order_receiver: {
        last_name: "山田", first_name: "太郎", zip_code: "150-0001",
        prefecture: "東京都", address: "渋谷区神南1-1-1", address2: "",
        tel: "0312345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10011, item_id: 201, variation_id: 0,
          title: "テストTシャツ M", barcode: "4901234567890",
          variation: "", variation_identifier: "",
          amount: 2, price: 2365, status: "ordered",
        },
      ],
      shipping_lines: [
        { order_item_ids: ["10011"], shipping_method: "宅配便", shipping_fee: 770 },
      ],
    },
    "MOCK-1002": {
      unique_key: "MOCK-1002", ordered: 1745500800, cancelled: null, dispatched: null,
      dispatch_status: "ordered", payment: "creditcard",
      shipping_method: null, shipping_fee: 0,
      total: 1100, first_name: "花子", last_name: "鈴木",
      zip_code: "530-0001", prefecture: "大阪府",
      address: "北区梅田1-1-1", address2: "", tel: "0612345678",
      remark: "急ぎでお願いします", modified: 1745500800, terminated: false,
      order_receiver: {
        last_name: "鈴木", first_name: "花子", zip_code: "530-0001",
        prefecture: "大阪府", address: "北区梅田1-1-1", address2: "",
        tel: "0612345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10021, item_id: 202, variation_id: 0,
          title: "テストステッカー", barcode: "4909999999991",
          variation: "", variation_identifier: "",
          amount: 1, price: 1100, status: "ordered",
        },
      ],
      shipping_lines: [
        { order_item_ids: ["10021"], shipping_method: "ネコポス", shipping_fee: 0 },
      ],
    },
    "MOCK-1003": {
      unique_key: "MOCK-1003", ordered: 1745504400, cancelled: null, dispatched: null,
      dispatch_status: "ordered", payment: "creditcard",
      shipping_method: null, shipping_fee: 0,
      total: 3300, first_name: "次郎", last_name: "佐藤",
      zip_code: "060-0001", prefecture: "北海道",
      address: "札幌市中央区北1条西1-1", address2: "", tel: "0112345678",
      remark: "", modified: 1745504400, terminated: false,
      order_receiver: null, // フォールバック動作確認用
      order_items: [
        {
          order_item_id: 10031, item_id: 203, variation_id: 0,
          title: "配送対象外テスト商品", barcode: "4908888888881",
          variation: "", variation_identifier: "",
          amount: 1, price: 3300, status: "ordered",
        },
      ],
      shipping_lines: [
        { order_item_ids: ["10031"], shipping_method: "配送対象外商品", shipping_fee: 0 },
      ],
    },
    "MOCK-1004": {
      unique_key: "MOCK-1004", ordered: 1745508000, cancelled: null, dispatched: null,
      dispatch_status: "ordered", payment: "creditcard",
      shipping_method: null, shipping_fee: 500,
      total: 2200, first_name: "三郎", last_name: "田中",
      zip_code: "460-0001", prefecture: "愛知県",
      address: "名古屋市中区三の丸1-1-1", address2: "", tel: "0522345678",
      remark: "", modified: 1745508000, terminated: false,
      order_receiver: {
        last_name: "田中", first_name: "三郎", zip_code: "460-0001",
        prefecture: "愛知県", address: "名古屋市中区三の丸1-1-1", address2: "",
        tel: "0522345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10041, item_id: 204, variation_id: 0,
          title: "不明配送テスト商品", barcode: "4907777777771",
          variation: "", variation_identifier: "",
          amount: 1, price: 2200, status: "ordered",
        },
      ],
      shipping_lines: [
        { order_item_ids: ["10041"], shipping_method: "未登録の配送方法XYZ", shipping_fee: 500 },
      ],
    },
  };

  const detail = mockDetails[uniqueKey];
  if (!detail) {
    throw new Error(`Mock order detail not found: ${uniqueKey}`);
  }
  return detail;
}

// BASE API クライアント（共通モジュール・永続）
// 注文取得・出荷完了書き戻しなど、BASE APIとの通信はすべてここ経由で行う

import { redis } from "@/lib/upstash";

const BASE_API_BASE_URL =
  process.env.BASE_API_BASE_URL ?? "https://api.thebase.in/1";

// ============================================================================
// 型定義
// ============================================================================

export type BaseOrderItem = {
  order_item_id: number;
  item_id: number;
  item_title: string;
  barcode: string;      // JANコード（スキャン照合用。識別子ではない。DATA-01 U4準拠）
  quantity: number;
  price: number;
  status: string;       // "ordered" / "cancelled" など。T3差分検知に使用
};

// 配送方法関連フィールド:
//   設計上必要な配送方法関連情報が取得できることを目的として、
//   shipping_method（単一文字列）と shipping_lines（配列）の両方を保持する。
//   実機確認前のため、BASE APIがどちらのパターンで返すかが未確定（実装参照文書 §10 確認項目5参照）。
//   ORDER-01でのカテゴリ判定はこれらのフィールドをもとに実装する。
export type BaseShippingLine = {
  method: string;
  fee: number;
};

/**
 * お届け先情報（order_receiver）。
 * 実機確認（C-1）により確定したキー名を使用。
 *
 * 姓名フィールドの注意:
 *   - キー名は first_name / last_name（名 / 姓の順でフィールドが存在する）
 *   - フルネームを組み立てる際は必ず last_name + first_name（姓→名）の順にする
 *   - first_name + last_name（名→姓）順での連結は禁止
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

export type BaseOrder = {
  order_id: number;
  ordered_at: string;
  dispatch_status: string;

  // 配送方法関連（実機確認前につき両パターンを保持。確認後に参照先を確定すること）
  shipping_method: string;              // パターンA: 単一文字列
  shipping_lines: BaseShippingLine[];   // パターンB: 配列形式。存在しない場合は空配列
  shipping_fee: number;
  total_price: number;
  remark: string;                       // 注文備考（BASE APIに書き込みAPIなし。読み取り専用）

  // 購入者情報（order_purchaser相当のトップレベルフィールド）
  // 用途: D6（注文一覧表示）・D5（領収書入力補助）・フォールバック源（DEST-01準拠）
  last_name: string;
  first_name: string;
  zip_code: string;
  prefecture: string;
  address: string;
  address2: string;
  tel: string;

  // お届け先情報（DEST-01 D1/D2/D3/D7 の基本データソース）
  // null = お届け先が購入者と同一（または存在しない）。フォールバック発動条件（DEST-01 §5）。
  order_receiver: BaseOrderReceiver | null;

  order_items: BaseOrderItem[];
};

type BaseOrdersApiResponse = {
  orders: BaseOrder[];
  total_count: number;
};

// ============================================================================
// お届け先ヘルパー関数（DEST-01準拠）
//
// 【フォールバック発動条件（DEST-01 §5）】
//   order_receiver が null、または全フィールドが空の場合に発動する。
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
// 本実装経路: BASE API から注文を取得する
// ============================================================================

export async function fetchOrderedOrders(): Promise<BaseOrder[]> {
  // ORDER-01 §3: dispatch_status: ordered で全注文を取得する
  // 配送方法フィルタは BASE API に存在しないため、取得後にアプリ側でカテゴリ判定を行う（ORDER-01準拠）

  if (!process.env.BASE_API_TOKEN) {
    // !! 開発補助用モックにフォールバック（本番経路ではない。下部コメント参照）
    return getMockOrders();
  }

  const token = await getBaseToken();
  const url = `${BASE_API_BASE_URL}/orders?dispatch_status=ordered&limit=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BASE API error: ${res.status} ${body}`);
  }

  const data: BaseOrdersApiResponse = await res.json();
  return data.orders;
}

// ============================================================================
// 開発補助用モックデータ
//
// 用途: BASE_API_TOKEN 未設定時（ローカル開発・CI環境）の動作確認専用
// 注意: 本番相当の挙動ではない。以下の点でリアルデータと異なる可能性がある
//   - shipping_lines の有無・構造（実機未確認）
//   - order_item_id の採番形式（実機未確認）
//   - BASE API のページネーション・フィールド追加・省略の可能性
// BASE_API_TOKEN が設定されると、この関数は呼び出されない。
// ============================================================================

function getMockOrders(): BaseOrder[] {
  return [
    {
      order_id: 1001,
      ordered_at: "2026-04-24T10:00:00+09:00",
      dispatch_status: "ordered",
      shipping_method: "宅配便",
      shipping_lines: [{ method: "宅配便", fee: 770 }],
      shipping_fee: 770,
      total_price: 5500,
      remark: "",
      last_name: "山田", first_name: "太郎",
      zip_code: "150-0001", prefecture: "東京都",
      address: "渋谷区神南1-1-1", address2: "", tel: "0312345678",
      order_receiver: {
        last_name: "山田", first_name: "太郎",
        zip_code: "150-0001", prefecture: "東京都",
        address: "渋谷区神南1-1-1", address2: "",
        tel: "0312345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10011, item_id: 201,
          item_title: "テストTシャツ M", barcode: "4901234567890",
          quantity: 2, price: 2365, status: "ordered",
        },
      ],
    },
    {
      order_id: 1002,
      ordered_at: "2026-04-24T11:00:00+09:00",
      dispatch_status: "ordered",
      shipping_method: "ネコポス",
      shipping_lines: [{ method: "ネコポス", fee: 0 }],
      shipping_fee: 0,
      total_price: 1100,
      remark: "急ぎでお願いします",
      last_name: "鈴木", first_name: "花子",
      zip_code: "530-0001", prefecture: "大阪府",
      address: "北区梅田1-1-1", address2: "", tel: "0612345678",
      order_receiver: {
        last_name: "鈴木", first_name: "花子",
        zip_code: "530-0001", prefecture: "大阪府",
        address: "北区梅田1-1-1", address2: "",
        tel: "0612345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10021, item_id: 202,
          item_title: "テストステッカー", barcode: "4909999999991",
          quantity: 1, price: 1100, status: "ordered",
        },
      ],
    },
    {
      order_id: 1003,
      ordered_at: "2026-04-24T12:00:00+09:00",
      dispatch_status: "ordered",
      shipping_method: "配送対象外商品",
      shipping_lines: [{ method: "配送対象外商品", fee: 0 }],
      shipping_fee: 0,
      total_price: 3300,
      remark: "",
      last_name: "佐藤", first_name: "次郎",
      zip_code: "060-0001", prefecture: "北海道",
      address: "札幌市中央区北1条西1-1", address2: "", tel: "0112345678",
      order_receiver: null,  // お届け先＝購入者と同一のケース（フォールバック動作確認用）
      order_items: [
        {
          order_item_id: 10031, item_id: 203,
          item_title: "配送対象外テスト商品", barcode: "4908888888881",
          quantity: 1, price: 3300, status: "ordered",
        },
      ],
    },
    {
      order_id: 1004,
      ordered_at: "2026-04-24T13:00:00+09:00",
      dispatch_status: "ordered",
      shipping_method: "未登録の配送方法XYZ",
      shipping_lines: [{ method: "未登録の配送方法XYZ", fee: 500 }],
      shipping_fee: 500,
      total_price: 2200,
      remark: "",
      last_name: "田中", first_name: "三郎",
      zip_code: "460-0001", prefecture: "愛知県",
      address: "名古屋市中区三の丸1-1-1", address2: "", tel: "0522345678",
      order_receiver: {
        last_name: "田中", first_name: "三郎",
        zip_code: "460-0001", prefecture: "愛知県",
        address: "名古屋市中区三の丸1-1-1", address2: "",
        tel: "0522345678", country: "Japan", country_code: "JP",
      },
      order_items: [
        {
          order_item_id: 10041, item_id: 204,
          item_title: "不明配送テスト商品", barcode: "4907777777771",
          quantity: 1, price: 2200, status: "ordered",
        },
      ],
    },
  ];
}

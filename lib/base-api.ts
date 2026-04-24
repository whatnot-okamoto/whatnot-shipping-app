// BASE API クライアント（共通モジュール・永続）
// 注文取得・出荷完了書き戻しなど、BASE APIとの通信はすべてここ経由で行う

const BASE_API_BASE_URL =
  process.env.BASE_API_BASE_URL ?? "https://api.thebase.in/1";
const BASE_API_TOKEN = process.env.BASE_API_TOKEN ?? "";

// --- 型定義 ---

export type BaseOrderItem = {
  order_item_id: number;
  item_id: number;
  item_title: string;
  barcode: string;      // JANコード（スキャン照合用。識別子ではない。DATA-01 U4準拠）
  quantity: number;
  price: number;
  status: string;       // cancelled 判定に使用（T3差分検知）
};

// 配送方法関連フィールド:
//   設計上必要な配送方法関連情報が取得できることを目的として、
//   shipping_method（単一文字列）と shipping_lines（配列）の両方を保持する。
//   実機確認前のため、BASE APIがどちらのパターンで返すかが未確定（実装参照文書 §10 確認項目5参照）。
//   ORDER-01でのカテゴリ判定はこれらのフィールドをもとにStep 3で実装する。
export type BaseShippingLine = {
  method: string;       // 配送方法名
  fee: number;
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
  receiver_name: string;
  receiver_zip_code: string;
  receiver_prefecture: string;
  receiver_address: string;
  receiver_address2: string;
  order_items: BaseOrderItem[];
};

type BaseOrdersApiResponse = {
  orders: BaseOrder[];
  total_count: number;
};

// =============================================================================
// 本実装経路: BASE API から注文を取得する
// =============================================================================

export async function fetchOrderedOrders(): Promise<BaseOrder[]> {
  // ORDER-01 §3: dispatch_status: ordered で全注文を取得する
  // 配送方法フィルタは BASE API に存在しないため、取得後にアプリ側でカテゴリ判定を行う（ORDER-01準拠）

  if (!BASE_API_TOKEN) {
    // !! 開発補助用モックにフォールバック（本番経路ではない。下部コメント参照）
    return getMockOrders();
  }

  const url = `${BASE_API_BASE_URL}/orders?dispatch_status=ordered&limit=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BASE_API_TOKEN}`,
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

// =============================================================================
// 開発補助用モックデータ
//
// 用途: BASE_API_TOKEN 未設定時（ローカル開発・CI環境）の動作確認専用
// 注意: 本番相当の挙動ではない。以下の点でリアルデータと異なる可能性がある
//   - shipping_lines の有無・構造（実機未確認）
//   - order_item_id の採番形式（実機未確認）
//   - BASE API のページネーション・フィールド追加・省略の可能性
// BASE_API_TOKEN が設定されると、この関数は呼び出されない。
// =============================================================================

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
      receiver_name: "山田 太郎",
      receiver_zip_code: "150-0001",
      receiver_prefecture: "東京都",
      receiver_address: "渋谷区神南1-1-1",
      receiver_address2: "",
      order_items: [
        {
          order_item_id: 10011,
          item_id: 201,
          item_title: "テストTシャツ M",
          barcode: "4901234567890",
          quantity: 2,
          price: 2365,
          status: "ordered",
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
      receiver_name: "鈴木 花子",
      receiver_zip_code: "530-0001",
      receiver_prefecture: "大阪府",
      receiver_address: "北区梅田1-1-1",
      receiver_address2: "",
      order_items: [
        {
          order_item_id: 10021,
          item_id: 202,
          item_title: "テストステッカー",
          barcode: "4909999999991",
          quantity: 1,
          price: 1100,
          status: "ordered",
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
      receiver_name: "佐藤 次郎",
      receiver_zip_code: "060-0001",
      receiver_prefecture: "北海道",
      receiver_address: "札幌市中央区北1条西1-1",
      receiver_address2: "",
      order_items: [
        {
          order_item_id: 10031,
          item_id: 203,
          item_title: "配送対象外テスト商品",
          barcode: "4908888888881",
          quantity: 1,
          price: 3300,
          status: "ordered",
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
      receiver_name: "田中 三郎",
      receiver_zip_code: "460-0001",
      receiver_prefecture: "愛知県",
      receiver_address: "名古屋市中区三の丸1-1-1",
      receiver_address2: "",
      order_items: [
        {
          order_item_id: 10041,
          item_id: 204,
          item_title: "不明配送テスト商品",
          barcode: "4907777777771",
          quantity: 1,
          price: 2200,
          status: "ordered",
        },
      ],
    },
  ];
}

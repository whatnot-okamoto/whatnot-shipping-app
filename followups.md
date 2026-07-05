# followups.md

## 位置づけ

この文書は、BASE出荷アプリ開発の未確定判断を管理する台帳である。

単なる「次に読むファイル一覧」ではない。各論点は、実装前確認、必要なGO、停止条件と一緒に管理する。

CoWork側の `followups` や `session_state` は重要設計資産として扱うが、この文書へ丸写ししない。Codex側で使う未確定判断へ要約・変換して扱う。

## 管理項目

各論点は、原則として以下の項目で管理する。

- 論点
- 現在の仮置き
- 実装前に確認すること
- 必要なGO
- 停止条件
- 参照元

## 初期論点

| 論点 | 現在の仮置き | 実装前に確認すること | 必要なGO | 停止条件 | 参照元 |
| --- | --- | --- | --- | --- | --- |
| 出荷完了ゲートの所在 | UI側限定確認では所在未確認。未実装・不具合とは断定しない。 | `session/end`、UI導線、完了条件、S5導線の関係。 | 目的単位のread-only GO | PDF / CSV / 帳票 / 配送 / 実データへ広げない。 | read-only棚卸し第一版、GO 8-B |
| `session/end` / `endSession` とUI導線の接続 | API/lib側は既確認。UI接続は未確定。 | 呼び出し元、完了条件、状態遷移。 | 目的単位のread-only GO | 未確認の接続を不具合扱いしない。 | read-only棚卸し第一版、移行設計戻し方針 |
| S5導線らしき disabled 状態の意図 | S4追跡番号入力までは確認済み。S5導線の意図は未確定。 | disabled条件、業務フロー上の位置づけ。 | 目的単位のread-only GO | UI限定確認を超えて生成系へ広げない。 | GO 8-B |
| PDF完了状態の確定処理 | 支払いラベル警告接続は確認済み。PDF生成全体は未確認。 | PDF完了状態がどこで確定するか。 | PDF論点限定read-only GO | 帳票、金額、実PDF、実データへ踏み込まない。 | read-only棚卸し第一版 |
| CSV出力状態と `skipped` 扱い | CSV生成詳細は未確認。業務上の位置づけも未確定。 | skippedの意味、配送CSV上の扱い、状態遷移。 | CSV論点限定read-only GO | 実CSV、配送実データ、請求・金額へ踏み込まない。 | read-only棚卸し第一版 |
| 追跡番号入力後の状態遷移 | 追跡番号入力UI/APIは確認済み。後続状態遷移は未確定。 | 保存後の状態、出荷完了との関係。 | 目的単位のread-only GO | 送り状番号など実データを扱わない。 | read-only棚卸し第一版 |
| 緊急解除UIとAPI側監査ログ保持 | UIとAPIは確認済みだが突き合わせは未確定。 | 理由、実行者名、監査ログ保持の整合。 | 目的単位のread-only GO | 実運用ログや個人情報へ踏み込まない。 | read-only棚卸し第一版 |
| BASE再認証callbackのstate検証とセッション紐づけ | OAuth callbackとして即NGとは扱わない。十分性は未確定。 | state検証、セッション紐づけ、トークン保存の安全性。 | 認証論点限定read-only GO | トークン値、`.env*`、実レスポンスを読まない。 | read-only棚卸し第一版 |
| 支払いラベル定義の運用 | 既知ラベル定義は確認済み。実運用上の十分性は未確定。 | 追加ラベルの管理方法、`bnpl_installment` の扱い。 | 設計判断GOまたは限定read-only GO | 実注文データや決済具体値へ踏み込まない。 | read-only棚卸し第一版 |
| debug / fixture を読む必要性 | 未読。実データ混入リスクあり。 | 読む目的、対象、記録しない具体値。 | 個別read-only GO | fixture本文へ惰性で入らない。実データ疑いは記録しない。 | read-only棚卸し第一版 |
| docs本文を設計素材として読む必要性 | docs本文は未読。現在実装事実ではなく設計素材候補。 | 何を原典保全し、何をlegacyに分けるか。 | docs設計素材read-only GO | docs本文を実装事実扱いしない。 | CoWork再接続方針、正式化判断 |
| 旧Claude/CoWork文書の吸収・legacy分離 | 旧文書は参考素材。Codex正本ではない。 | 吸収する停止条件、廃止する旧手順、legacy化する文書。 | docs配置設計GO | 旧投入手順や外部監査固定工程をそのまま移植しない。 | CoWork初期素材、再接続方針 |
| DEST-01 の未確定項目の扱い | `docs/reference/` に設計補強メモとして移動するが、実機確認待ちを含む未確定要素がある。 | DEST系の未確定項目、実機確認待ちの範囲、現在実装との整合。 | DEST論点限定read-only GO または設計判断GO | 未確認項目を確定仕様や現在実装事実として扱わない。実データ、実CSV、実PDF、APIレスポンスには踏み込まない。 | `docs/reference/WHATNOT出荷アプリ_設計補強メモ_DEST-01.md.md` |
| `E-1補正メモ.md` の保留扱い | 実CSV確認を根拠にした記載があるため、今回は `docs/` 直下に保留。 | E-1本体との関係、実データ由来根拠を含む記載の扱い、設計補正として残せる範囲。 | E-1補正メモ限定read-only GO または設計判断GO | 実CSV本文、具体値、実データ、実PDF、実レスポンスへ踏み込まない。現在実装事実として断定しない。 | `docs/E-1補正メモ.md` |
| Vercel Production自動deploy接続の現在状態 | Vercel Dashboard Overview上では `12b6906` の Production Deployment が `Ready`、Source は `master / 12b6906` と確認済み。ただし、Settings > Git のURLとタブタイトルまでは確認できたが、接続repo・Production Branch詳細はChrome接続不安定により未確認。push済み・Ready表示済み＝本番正常確認済みとは扱わない。 | Connected Git Repository、Production Branch、GitHub repo接続欄、Deployment Source詳細。本番URLアクセス・本番実機確認・本番正常性は別GO。 | Vercel Settings > Git read-only再確認GO。必要なら本番確認GOは別途。 | Vercel設定変更、Create Deployment / Redeploy / Promote to Production、本番URLアクセス、環境変数値確認、実データ確認をしない。`.env*`、実CSV、実PDF、API実レスポンスにも進まない。 | CoWork聞き取り結果、Vercel Dashboard Overview確認結果、`12b6906` push完了記録。 |

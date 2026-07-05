# AGENTS.md

## 役割

このリポジトリは、BASE出荷アプリの正式なCodex開発rootである。

BASE出荷アプリは新規開発ではなく、既存開発の引き継ぎ対象として扱う。過去の設計資産、旧Claude / CoWork由来文書、既存 `docs/`、現在の実装状態を混同せず、作業時点で確認できた事実だけを現在実装事実として扱う。

## 作業前確認

作業前に、目的、GO種別、対象範囲、禁止範囲、参照すべき正本を確認する。

GO境界、高リスク領域、停止条件は `workflow_risk_gate.md` を参照する。未確定判断や後続確認が必要な論点は `followups.md` を参照する。

CoWork側の要件定義、概要設計、設計補強、設計判断、残論点、現在地は重要設計資産として扱う。ただし、それらを現在実装事実そのものとは扱わない。

旧Claude / CoWork手順、旧投入文、旧agent設計、ChatGPT外部監査固定工程は、そのままCodex運用へ移植しない。必要に応じて参照、legacy、再設計候補として扱う。

ChatGPT外部監査は固定工程ではなく、必要時に使うレビュー手段の一つとして扱う。

## 技術スタック注意

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

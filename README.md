# X Radar 自動日本語翻訳 Chrome 拡張

X Radar（`https://x.com/i/radar/<id>`）の日本語以外の投稿を、ページを開くだけで自動的に日本語へ「その場置換」で翻訳する Chrome 拡張機能。

## 特徴

- **Chrome 組み込み翻訳 API**（`Translator` / `LanguageDetector`）を使用。無料・オンデバイス・API キー不要、投稿テキストを外部サーバーに送信しない。
- 日本語の投稿は翻訳せずそのまま表示。
- 翻訳後も原文はホバー（`title` ツールチップ）で確認可能。翻訳済みは左の青いラインで区別。
- `t.co` URL・@メンション・#ハッシュタグは保護して原形を維持（大文字小文字も保持）。
- 仮想スクロールで追加読み込みされる投稿も自動翻訳（`MutationObserver`）。

## 仕組み

1. URL が `/i/radar/` を含むときだけ起動（X は SPA なので履歴 API のラップ + URL ポーリングで遷移を検知）。
2. 投稿本文（`div.whitespace-pre-wrap.break-words.text-body`）を走査し、`LanguageDetector` で言語判定。
3. 日本語・判定不能・低信頼度はスキップ。それ以外は `Translator` で日本語へ翻訳し `textContent` を置換。
4. Chrome のオンデバイス翻訳は改行混じりの SNS テキストで行やトークンを欠落させるため、**行単位に分割 → 行内を URL/@/# で分割 → 散文セグメントだけ翻訳**し、トークンは元位置に残す。

> 注: コンテンツスクリプトは `world: "MAIN"` で動作する。組み込み翻訳 API へのアクセスと、X 本体の SPA 遷移（`history.pushState`）の確実な捕捉のため。`chrome.*` API は使用しない。

## 技術スタック

- Manifest V3 / 素の JavaScript（ビルド不要）

## インストール（開発時）

1. `chrome://extensions` を開く。
2. 右上の「デベロッパーモード」をオン。
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択。
4. Radar ページ（例: `https://x.com/i/radar/<id>`）を開く。
5. 初回は右下に表示される「翻訳を有効化」ボタンをクリックして翻訳モデルをダウンロード（言語ごとに一度だけ、数秒）。以降は自動翻訳。

## 既知の制約

- 初回のみ言語ごとにワンクリックでオンデバイス翻訳モデルの DL が必要（Chrome の仕様。`Translator.create()` はモデル未取得時にユーザー操作を要求する）。DL 後は自動翻訳。
- 翻訳品質は Chrome オンデバイス翻訳相当（実用十分・完璧ではない）。
- 組み込み翻訳 API 対応の Chrome バージョン（Chrome 138+ 目安）が必要。

## ファイル構成

```
manifest.json          # MV3 設定（matches: x.com/*, world: MAIN）
src/translator.js      # 言語判定 + 翻訳器プール + 構造保持翻訳
src/ui.js              # 有効化ボタン・翻訳済みマーカー
src/content.js         # SPA遷移検知・MutationObserver・本文処理ループ
styles/content.css     # マーカー / ボタンのスタイル
```

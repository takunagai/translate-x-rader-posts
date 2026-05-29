# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

X Radar（`https://x.com/i/radar/<id>`）の日本語以外の投稿を、Chrome 組み込み翻訳 API でオンデバイス翻訳し「その場置換」する Manifest V3 拡張。素の JavaScript・ビルド不要。

## コマンド / 検証

ビルド・lint・テストフレームワークは無い（`package.json` も無い）。検証は以下:

- **構文チェック**: `node --check src/translator.js && node --check src/ui.js && node --check src/content.js`
- **ns API の定義/参照整合**（cross-file は静的検証できないため grep で確認）:
  `grep -hA8 "Object.assign(ns" src/*.js` と `grep -ohE "ns\.[a-zA-Z]+" src/content.js` を突き合わせる
- **読み込み**: `chrome://extensions` → デベロッパーモード ON →「パッケージ化されていない拡張機能を読み込む」。**コード編集後は拡張のリロードが必須**（content script は再注入される）。
- **動作検証（唯一の実テスト手段＝実機）**: ログイン済み Chrome で Radar URL を開き、右下「翻訳を有効化」をクリック。DevTools / Claude in Chrome で確認。確認用スニペット例:
  - `document.querySelectorAll('.xr-translated').length`（翻訳済み件数）
  - `[...document.querySelectorAll('div.whitespace-pre-wrap.break-words.text-body')].map(e=>e.dataset.xrState)`（状態分布）

## アーキテクチャ

- **MV3 / `world: "MAIN"`** の content script 3 本を `manifest.json` の順序 `[translator, ui, content]` で注入。共有名前空間 `window.__xrT`（=`ns`）に関数をぶら下げる。`translator.js`/`ui.js` は `ns = window.__xrT || {}` で生成、`content.js` は読むだけ（`if (!ns) return`）。
- **MAIN world のため `chrome.*` API は使えない**。`chrome.storage` 等が要る機能（設定 UI・永続化）は isolated world ブリッジの追加か world 変更が前提になる。
- 責務分割:
  - `src/translator.js` — 翻訳コア。`LanguageDetector`/`Translator` のプール、availability と translator の **Promise メモ化**、用語集 + URL/@/# の **トークン保護**、構造保持翻訳 `translateRich`。export: `TARGET_LANG, hasApis, detectLang, detectorNeedsDownload, translate, ensureDownloaded`
  - `src/ui.js` — フローティング有効化ボタン + 翻訳済みマーカー（見た目のみ）。export: `setActivateHandler, addPendingLang, setNeedsDetector, clearPending, markTranslated`
  - `src/content.js` — 制御ループ。SPA 遷移検知は **Navigation API の `navigate` イベント**（非対応ブラウザは `popstate` + URL ポーリングにフォールバック）で `/i/radar/` 滞在時のみ稼働。`history` のグローバル改変・常時ポーリングは行わない。`MutationObserver(document.body)` → デバウンス `scan` → **同時実行上限付きプール** → `processBody`。`ns.__contentLoaded` で二重注入をガード。
- **投稿の状態機械**: 各本文 `div`（`div.whitespace-pre-wrap.break-words.text-body`）の `data-xr-state` ∈ `working / translated / ja / skip / pending / error`、再試行は `data-xr-retry`。`scan` は `:not([data-xr-state])` で未処理のみ対象。原文は `title` 属性に保持（ホバー表示・復元用）。状態の書き込みは `content.js` に一元化（`ui.js` は class/title のみ）。

## このコードベース特有の制約（変更前に必読）

1. **モデル DL にはユーザージェスチャーが必要**。`Translator.create()`（および `LanguageDetector.create()`）はモデルが `"downloadable"` のとき gesture 無しだと `NotAllowedError`。よって DL は有効化ボタンの click ハンドラ経由（`ensureDownloaded`）でのみ可能。自動ロード経路（`getDetector`）は DL 済みのときだけ成功する。
2. **翻訳は「分割保護」方式が唯一安定**。Chrome オンデバイス翻訳は改行混じりの一括テキストで行/トークンを欠落させ、PUA プレースホルダも脱落する。そのため `translateRich` は「行分割 → 行内を URL/@/#/用語集 で分割 → 散文セグメントだけ翻訳 → トークンは原文のまま連結」。**プレースホルダ置換方式は使わないこと**（過去に検証して破棄）。
3. **用語集（`GLOSSARY` in `translator.js`）も分割保護**で固有名詞（`Seedance` 等）を温存。`Seedance→種子` のような誤訳を防ぐ。「全文翻訳→崩れた語を復元」方式は採用しない（孤立翻訳≠文脈内翻訳で復元が外れる）。語境界 `\b` + 最長一致 + 大文字小文字非依存。語は配列で増減。
4. **翻訳先は `TARGET_LANG` 定数（既定 `"ja"`）**。判定スキップ・翻訳器プール・有効化フローが全てこれを参照するので 1 行で切替可能。ランタイム選択 UI は未実装（導入時は制約 1・MAIN world の `chrome.*` 不可に注意）。
5. **`ensureDownloaded` は全 `create` を同期的に発火**させて `Promise.all` で待つ。逐次 `await` だと最初の DL 解決で transient activation が失効し 2 件目以降が失敗するため（多言語同時 DL 対応）。
6. **X Radar は新規ノードを追加し再利用しない**ことを実機確認済み。だから「ノード単位の `data-xr-state` + `MutationObserver`」で安全（ノード再利用が起きるなら設計見直しが必要）。
7. `match` は `https://x.com/*` と `https://twitter.com/*`（広め）。X は SPA で初回 URL でしか注入されないため全 x.com に注入し、`/i/radar/` を含むときだけ `start()` する。

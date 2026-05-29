# X Radar 自動日本語翻訳 Chrome 拡張

X Radar（`https://x.com/i/radar/<id>`）の日本語以外の投稿を、ページを開くだけで自動的に日本語へ **その場置換** で翻訳する Chrome 拡張機能。翻訳は Chrome 組み込みの **オンデバイス翻訳 API** を使うため、無料・API キー不要で、投稿テキストを外部サーバーに送信しません。

## 特徴

- **完全オンデバイス**: Chrome の `Translator` / `LanguageDetector` API を使用。無料・APIキー不要・通信なし。
- **その場置換**: 投稿本文を日本語に置き換えて表示。原文はホバー（`title` ツールチップ）で確認でき、翻訳済みは左の青いラインで区別。
- **日本語は素通し**: 日本語投稿・判定不能・低信頼度はスキップ。
- **構造を壊さない**: `t.co` URL・@メンション・#ハッシュタグは保護して原形を維持（大文字小文字も保持）。
- **用語集で誤訳防止**: AI 固有名詞（`GPT Image 2` / `Seedance` / `Nano Banana` / `Midjourney` / `Stable Diffusion` / `ComfyUI` / `LoRA` 等）を翻訳せず原形維持（`Seedance→種子` のような誤訳を防ぐ）。
- **追加読み込みに追従**: 仮想スクロールで増える投稿も `MutationObserver` で自動翻訳。

## 必要環境

- Chrome 138 以降が目安（組み込み翻訳 API `Translator` / `LanguageDetector` 対応版）。
- 対応していないブラウザでは何もせず、コンソールに警告のみ出力します。

## インストール（開発時 / load unpacked）

1. `chrome://extensions` を開く。
2. 右上の「デベロッパーモード」をオン。
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択。
4. X Radar のページ（例: `https://x.com/i/radar/<id>`）を開く。

> コードを編集したら、`chrome://extensions` で拡張をリロードしてからページを再読み込みしてください。

## 使い方

- **初回のみ**、右下に表示される **「翻訳を有効化」** ボタンをクリックして翻訳モデルをダウンロードします（言語ごとに一度だけ・数秒）。以降は自動翻訳。
  - これは Chrome の仕様で、モデル未取得時の `Translator.create()` がユーザー操作（クリック）を必須とするためです。DL 後はジェスチャー不要で自動的に走ります（モデルはブラウザのプロファイル単位で共有）。
- 翻訳済みの投稿にマウスを乗せると、`title` ツールチップで原文を確認できます。

## 仕組み（アーキテクチャ）

content script 3 本を `world: "MAIN"` で `[translator.js, ui.js, content.js]` の順に注入し、`window.__xrT` 名前空間を共有します。

1. **起動制御**（`content.js`）: X は SPA なので、Navigation API の `navigate` イベント（pushState/replaceState/戻る進むを網羅）で遷移を検知し、URL が `/i/radar/` を含むときだけ翻訳エンジンを起動。Navigation API 非対応ブラウザは `popstate` + URL ポーリングにフォールバック。
2. **走査と判定**: 投稿本文（`div.whitespace-pre-wrap.break-words.text-body`）を `MutationObserver` で監視し、`LanguageDetector` で言語を判定。日本語・判定不能・低信頼度（< 0.5）はスキップ。
3. **構造保持翻訳**（`translator.js`）: それ以外を `Translator` で日本語へ翻訳し `textContent` を置換。
4. **状態管理**: 各本文に `data-xr-state`（`working` / `translated` / `ja` / `skip` / `pending` / `error`）を付与し、未処理（`:not([data-xr-state])`）だけを処理。原文は `title` に保持。

## 実装上の重要ポイント（技術メモ）

実機検証で判明した制約と、その対処を記録します。改修時はこれらを踏まえてください。

- **モデル DL のジェスチャー要件**: `Translator.create()` / `LanguageDetector.create()` はモデルが `"downloadable"` のときユーザー操作なしだと `NotAllowedError`。そのため DL は有効化ボタンの click 内（`ensureDownloaded`）でのみ実行し、`ensureDownloaded` は **全モデルの `create` を同期的に発火**させて `Promise.all` で待つ（逐次 `await` だと最初の DL 解決で transient activation が失効し、2 件目以降の DL が失敗するため）。
- **分割保護方式の翻訳**: Chrome のオンデバイス翻訳は、改行混じりの SNS テキストを一括で渡すと行やトークンを欠落させる。さらに Private Use Area などのプレースホルダも脱落する。そこで `translateRich` は **行単位に分割 → 行内を URL/@/#/用語集 で分割 → 散文セグメントだけを翻訳 → トークンは元位置に残す**。プレースホルダ置換方式は使わない。
- **用語集（`GLOSSARY`）**: 上記トークン保護に AI 固有名詞を統合。語境界 `\b` + 最長一致 + 大文字小文字非依存で、`ChatGPT` 内の `GPTs` を誤マッチしない等を担保。トレードオフとして、1 文に固有名詞が多いと分割のぶん訳文がやや途切れがち（フィードは短いキャプションが多く実害は小）。フルーエンシー優先の語は外す。「全文翻訳→崩れた語を復元」方式は孤立翻訳と文脈内翻訳が一致せず不安定なため採用していない。
- **並行制御と堅牢性**: `getTranslator` / `availabilityOf` は **Promise メモ化**して同一言語の `Translator.create` / `availability` の多重発行を防止。`scan` は **同時実行上限付きプール**（既定 4）で `processBody` を回し、一括挿入時の輻輳を回避。翻訳失敗は **リトライ上限**（既定 3）で `error` 終端にし無限リトライを防止。`availability` のエラーや DL 失敗はキャッシュせず再評価可能に保つ。
- **再入防止**: `processBody` は最初の `await` より前に `data-xr-state="working"` を同期的に確保し、検出待ち中の二重処理を防ぐ。
- **`world: "MAIN"` の採用理由**: 組み込み翻訳 API への確実なアクセスのため（SPA 遷移検知は Navigation API に移行し、`history` のグローバル改変は廃止）。代償として **`chrome.*` API（`chrome.storage` 等）は使えない**ので、設定 UI・永続化を足す場合は isolated world ブリッジの追加か world 変更が前提になる。
- **二重注入ガード**: 拡張リロード等での再注入に備え、`ns.__contentLoaded` で SPA 遷移リスナ（`navigate` 等）の二重登録や制御ループの重複起動を防止。
- **ノード再利用の前提**: X Radar は新規ノードを追加し既存ノードを再利用しないことを実機確認済み。よってノード単位の `data-xr-state` + `MutationObserver` で安全（再利用が起きる設計なら見直しが必要）。

## 設定（コード内）

- **保護語の増減**: `src/translator.js` の `GLOSSARY` 配列に語を足す/外す。
- **翻訳先の変更**: `src/translator.js` の `const TARGET_LANG = "ja";` を別の言語コードに変更（判定スキップ・翻訳器プール・有効化フローが全てこれを参照するため 1 行で切替可能。ランタイム選択 UI は未実装）。

## ファイル構成

```
manifest.json          # MV3 設定（matches: x.com/* と twitter.com/*、world: MAIN）
src/translator.js      # 言語判定 + 翻訳器プール + 用語集/トークン保護 + 構造保持翻訳
src/ui.js              # 有効化ボタン・翻訳済みマーカー（状態書き込みは content.js に一元化）
src/content.js         # SPA遷移検知・MutationObserver・同時実行プール・状態機械
styles/content.css     # マーカー / ボタンのスタイル
```

## 既知の制約

- 初回のみ言語ごとにワンクリックでオンデバイス翻訳モデルの DL が必要（Chrome の仕様）。DL 後は自動。
- 翻訳品質は Chrome オンデバイス翻訳相当（実用十分・完璧ではない）。
- Chrome が非対応の言語ペアは `availability` が unavailable となりスキップされる。

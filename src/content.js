// content.js — 制御ループ
// X は SPA なので、URL が /i/radar/ を含むときだけ翻訳エンジンを起動する。
// MutationObserver で仮想スクロール時の追加投稿にも追従する。
(() => {
  "use strict";

  const ns = window.__xrT;
  if (!ns) return;
  // 二重注入（拡張リロード等）時に history 多重ラップ・タイマー重複を防ぐ
  if (ns.__contentLoaded) return;
  ns.__contentLoaded = true;

  // 投稿本文のセレクタ（実機検証で確定。本文はプレーンテキストで子要素なし）
  const BODY_SELECTOR = "div.whitespace-pre-wrap.break-words.text-body";
  const RADAR_PATTERN = /\/i\/radar\//;
  const SCAN_DEBOUNCE_MS = 300;
  const URL_POLL_MS = 500;
  const MAX_TRANSLATE_RETRIES = 3; // 恒久失敗の無限リトライを防ぐ
  const MAX_CONCURRENT = 4; // 一括挿入時の翻訳輻輳を防ぐ同時実行上限

  let observer = null;
  let isRunning = false;
  let scanTimer = null;
  let detectorReady = true; // 言語判定モデルが使えるか（未DLなら有効化まで false）

  // 同時実行を絞るための簡易キュー
  let activeCount = 0;
  const queue = [];
  const queued = new WeakSet();

  function isOnRadar() {
    return RADAR_PATTERN.test(location.pathname);
  }

  async function processBody(element) {
    // data-xr-state が付いていれば処理済み（translated/ja/skip/pending/working/error）
    if (element.dataset.xrState) return;
    // await より前に同期的に状態を確保し、検出待ち中の再入（二重処理）を防ぐ
    element.dataset.xrState = "working";

    const text = (element.textContent || "").trim();
    // 短すぎ/判定不能は detectLang が null を返す（最低文字数の閾値もそちらに集約）
    const lang = await ns.detectLang(text);
    if (!lang) {
      element.dataset.xrState = "skip";
      return;
    }
    if (lang === ns.TARGET_LANG) {
      element.dataset.xrState = "ja";
      return;
    }

    try {
      const result = await ns.translate(text, lang);
      if (result.ok) {
        element.textContent = result.text;
        ns.markTranslated(element, text); // title=原文 / マーカー付与
        element.dataset.xrState = "translated";
      } else if (result.needsDownload) {
        element.dataset.xrState = "pending";
        ns.addPendingLang(lang);
      } else {
        element.dataset.xrState = "skip";
      }
    } catch (error) {
      console.warn("[xr] 翻訳に失敗", { lang, error: String(error) });
      const retries = Number(element.dataset.xrRetry || "0") + 1;
      if (retries >= MAX_TRANSLATE_RETRIES) {
        element.dataset.xrState = "error"; // 終端：以後リトライしない
      } else {
        element.dataset.xrRetry = String(retries);
        delete element.dataset.xrState; // 一時失敗は次回スキャンで再試行
      }
    }
  }

  // 同時実行数を制限して processBody を回す
  function pump() {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
      const element = queue.shift();
      queued.delete(element);
      activeCount++;
      processBody(element).finally(() => {
        activeCount--;
        pump();
      });
    }
  }

  function scan() {
    if (!detectorReady) return; // 言語判定モデルが未DLの間は走らせない（誤 skip 防止）
    document
      .querySelectorAll(`${BODY_SELECTOR}:not([data-xr-state])`)
      .forEach((element) => {
        if (queued.has(element)) return;
        queued.add(element);
        queue.push(element);
      });
    pump();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  // 有効化ボタンのクリック内から呼ばれる（ジェスチャーあり）
  async function activate(langs, onProgress) {
    await ns.ensureDownloaded(langs, onProgress);
    detectorReady = true; // 言語判定モデルも ensureDownloaded で用意済み
    // pending 状態の投稿を未処理に戻して再スキャン
    document
      .querySelectorAll(`${BODY_SELECTOR}[data-xr-state="pending"]`)
      .forEach((element) => {
        delete element.dataset.xrState;
      });
    ns.setNeedsDetector(false);
    ns.clearPending();
    scan();
  }

  async function start() {
    if (isRunning) return;
    if (!ns.hasApis()) {
      console.warn(
        "[xr] このブラウザでは Translator / LanguageDetector API が利用できません（Chrome 138+ の組み込み翻訳対応版が必要）"
      );
      return;
    }
    isRunning = true;
    ns.setActivateHandler(activate);
    // ノード追加を伴う変化のときだけスキャンする（属性のみ・削除のみは無視）
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.addedNodes && record.addedNodes.length > 0) {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 言語判定モデルが未DLなら、誤判定で全 skip にせず有効化ボタンを出す
    if (await ns.detectorNeedsDownload()) {
      detectorReady = false;
      ns.setNeedsDetector(true);
    }
    scan();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scanTimer);
    ns.clearPending();
  }

  function sync() {
    if (isOnRadar()) {
      start();
    } else {
      stop();
    }
  }

  // SPA 遷移検知: Navigation API（イベント駆動）を優先。
  // history.pushState の改変やポーリングを行わず、グローバル副作用・検知容易性を避ける。
  // navigate イベントは pushState/replaceState/戻る進む（traverse）すべてで発火する。
  if (typeof navigation !== "undefined" && navigation.addEventListener) {
    navigation.addEventListener("navigate", () => setTimeout(sync, 0));
  } else {
    // フォールバック（Navigation API 非対応ブラウザ）: popstate + URL ポーリング
    window.addEventListener("popstate", () => setTimeout(sync, 0));
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        sync();
      }
    }, URL_POLL_MS);
  }

  sync();
})();

// content.js — 制御ループ
// X は SPA なので、URL が /i/radar/ を含むときだけ翻訳エンジンを起動する。
// MutationObserver で仮想スクロール時の追加投稿にも追従する。
(() => {
  "use strict";

  const ns = window.__xrT;
  if (!ns) return;

  // 投稿本文のセレクタ（実機検証で確定。本文はプレーンテキストで子要素なし）
  const BODY_SELECTOR = "div.whitespace-pre-wrap.break-words.text-body";
  const RADAR_PATTERN = /\/i\/radar\//;
  const SCAN_DEBOUNCE_MS = 300;
  const URL_POLL_MS = 500;

  let observer = null;
  let isRunning = false;
  let scanTimer = null;

  function isOnRadar() {
    return RADAR_PATTERN.test(location.pathname);
  }

  async function processBody(element) {
    // data-xr-state が付いていれば処理済み（translated/ja/skip/pending/working）
    if (element.dataset.xrState) return;

    const text = (element.textContent || "").trim();
    if (text.length < 4) {
      element.dataset.xrState = "skip";
      return;
    }

    const lang = await ns.detectLang(text);
    if (!lang) {
      element.dataset.xrState = "skip";
      return;
    }
    if (lang === ns.TARGET_LANG) {
      element.dataset.xrState = "ja";
      return;
    }

    // 翻訳中の二重処理を防ぐ
    element.dataset.xrState = "working";
    try {
      const result = await ns.translate(text, lang);
      if (result.ok) {
        element.dataset.xrOriginal = text;
        element.textContent = result.text;
        ns.markTranslated(element, text);
      } else if (result.needsDownload) {
        element.dataset.xrState = "pending";
        element.dataset.xrLang = lang;
        ns.addPendingLang(lang);
      } else {
        element.dataset.xrState = "skip";
      }
    } catch (error) {
      console.warn("[xr] 翻訳に失敗", { lang, error: String(error) });
      delete element.dataset.xrState; // 次回スキャンで再試行
    }
  }

  function scan() {
    document.querySelectorAll(BODY_SELECTOR).forEach((element) => {
      processBody(element);
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  // 有効化ボタンのクリック内から呼ばれる（ジェスチャーあり）
  async function activate(langs, onProgress) {
    await ns.ensureDownloaded(langs, onProgress);
    // pending 状態の投稿を未処理に戻して再スキャン
    document
      .querySelectorAll(`${BODY_SELECTOR}[data-xr-state="pending"]`)
      .forEach((element) => {
        delete element.dataset.xrState;
        delete element.dataset.xrLang;
      });
    ns.clearPending();
    scan();
  }

  function start() {
    if (isRunning) return;
    if (!ns.hasApis()) {
      console.warn(
        "[xr] このブラウザでは Translator / LanguageDetector API が利用できません（Chrome 138+ の組み込み翻訳対応版が必要）"
      );
      return;
    }
    isRunning = true;
    ns.setActivateHandler(activate);
    scan();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
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

  // SPA 遷移検知: history API のラップ + popstate + URL ポーリング（保険）
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    setTimeout(sync, 0);
  };
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    setTimeout(sync, 0);
  };
  window.addEventListener("popstate", () => setTimeout(sync, 0));

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    }
  }, URL_POLL_MS);

  sync();
})();

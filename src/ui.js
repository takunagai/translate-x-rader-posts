// ui.js — 有効化ボタン・翻訳済みマーカー
// 未DLの言語判定/翻訳モデルがあるときフローティングボタンを表示し、
// クリック（=ユーザージェスチャー）でモデルDLをトリガーする。
// 翻訳済み要素にはマーカーと原文ツールチップを付ける。
(() => {
  "use strict";

  const ns = (window.__xrT = window.__xrT || {});

  let button = null;
  const pendingLangs = new Set();
  let needsDetector = false; // 言語判定モデルが未DLか
  let isDownloading = false; // DL進捗表示中はラベルを上書きしない
  let activateHandler = null; // content.js が登録する有効化処理

  function setActivateHandler(handler) {
    activateHandler = handler;
  }

  function ensureButton() {
    if (button) return button;
    button = document.createElement("button");
    button.className = "xr-enable-btn";
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!activateHandler) return;
      const targets = Array.from(pendingLangs);
      isDownloading = true;
      button.disabled = true;
      try {
        await activateHandler(targets, (src, loaded) => {
          const percent = Math.round((loaded || 0) * 100);
          button.textContent = `翻訳モデルをDL中… ${percent}%`;
        });
      } catch (error) {
        console.warn("[xr] 有効化に失敗", { error: String(error) });
      } finally {
        isDownloading = false;
        button.disabled = false;
        refreshButton();
      }
    });
    document.body.appendChild(button);
    return button;
  }

  function refreshButton() {
    if (!button) return;
    if (isDownloading) return; // DL中は進捗テキストを保持（addPendingLang 等で上書きしない）
    const labels = [];
    if (needsDetector) labels.push("言語判定");
    labels.push(...pendingLangs);
    if (labels.length === 0) {
      button.style.display = "none";
      return;
    }
    button.textContent = `翻訳を有効化 (${labels.join(", ")})`;
    button.style.display = "block";
  }

  function addPendingLang(src) {
    if (pendingLangs.has(src)) return;
    pendingLangs.add(src);
    ensureButton();
    refreshButton();
  }

  function setNeedsDetector(value) {
    needsDetector = !!value;
    if (needsDetector) ensureButton();
    refreshButton();
  }

  function clearPending() {
    pendingLangs.clear();
    refreshButton();
  }

  // 見た目だけ担当（状態 data-xr-state の書き込みは content.js に一元化）
  function markTranslated(element, originalText) {
    element.title = originalText;
    element.classList.add("xr-translated");
  }

  Object.assign(ns, {
    setActivateHandler,
    addPendingLang,
    setNeedsDetector,
    clearPending,
    markTranslated,
  });
})();

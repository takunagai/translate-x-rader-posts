// ui.js — 有効化ボタン・翻訳済みマーカー
// 未DL言語が見つかったときフローティングボタンを表示し、クリック（=ユーザージェスチャー）で
// モデルDLをトリガーする。翻訳済み要素にはマーカーと原文ツールチップを付ける。
(() => {
  "use strict";

  const ns = (window.__xrT = window.__xrT || {});

  let button = null;
  const pendingLangs = new Set();
  let activateHandler = null; // content.js が登録する有効化処理

  function setActivateHandler(handler) {
    activateHandler = handler;
  }

  function pendingLabel() {
    return Array.from(pendingLangs).join(", ");
  }

  function ensureButton() {
    if (button) return button;
    button = document.createElement("button");
    button.className = "xr-enable-btn";
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!activateHandler) return;
      const targets = Array.from(pendingLangs);
      button.disabled = true;
      try {
        await activateHandler(targets, (src, loaded) => {
          const percent = Math.round((loaded || 0) * 100);
          button.textContent = `翻訳モデルをDL中… ${percent}%`;
        });
      } catch (error) {
        console.warn("[xr] 有効化に失敗", { error: String(error) });
      } finally {
        button.disabled = false;
        refreshButton();
      }
    });
    document.body.appendChild(button);
    return button;
  }

  function refreshButton() {
    if (!button) return;
    if (pendingLangs.size === 0) {
      button.style.display = "none";
      return;
    }
    button.textContent = `翻訳を有効化 (${pendingLabel()})`;
    button.style.display = "block";
  }

  function addPendingLang(src) {
    if (pendingLangs.has(src)) return;
    pendingLangs.add(src);
    ensureButton();
    refreshButton();
  }

  function getPendingLangs() {
    return Array.from(pendingLangs);
  }

  function clearPending() {
    pendingLangs.clear();
    refreshButton();
  }

  function markTranslated(element, originalText) {
    element.title = originalText;
    element.classList.add("xr-translated");
    element.dataset.xrState = "translated";
  }

  Object.assign(ns, {
    setActivateHandler,
    addPendingLang,
    getPendingLangs,
    clearPending,
    markTranslated,
  });
})();

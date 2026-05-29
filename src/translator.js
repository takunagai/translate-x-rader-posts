// translator.js — 言語判定 + 翻訳器プール + 構造保持翻訳
// MAIN world で実行され、Chrome 組み込みの LanguageDetector / Translator API を使う。
// 名前空間 window.__xrT に関数をぶら下げ、ui.js / content.js から参照する。
//
// 重要: Chrome オンデバイス翻訳は、改行混じりの SNS テキストを一括で渡すと
// 一部の行やトークンを欠落させる。そこで「行単位に分割 → 行内を URL/@/# で分割 →
// 散文セグメントだけを翻訳し、URL・メンション・ハッシュタグは元位置に残す」方式を採る。
(() => {
  "use strict";

  const TARGET_LANG = "ja";
  // 言語判定の最低信頼度。これ未満はスキップ（タグ・URL のみの投稿など）
  const MIN_CONFIDENCE = 0.5;

  // 翻訳から保護するトークン: URL / @メンション / #ハッシュタグ
  const TOKEN_SOURCE = "https?:\\/\\/\\S+|@\\w+|#[\\p{L}\\p{N}_]+";
  const TOKEN_TEST = new RegExp(TOKEN_SOURCE, "u");
  const TOKEN_SPLIT = new RegExp("(" + TOKEN_SOURCE + ")", "gu");
  const HAS_LETTER = /[\p{L}]/u;

  const ns = (window.__xrT = window.__xrT || {});

  let detector = null;
  let detectorPromise = null;
  const translators = new Map(); // src -> TranslatorInstance
  const availabilityCache = new Map(); // src -> "available" | "downloadable" | ...

  function hasApis() {
    return typeof LanguageDetector !== "undefined" && typeof Translator !== "undefined";
  }

  async function getDetector() {
    if (detector) return detector;
    if (!detectorPromise) {
      detectorPromise = LanguageDetector.create().then((d) => (detector = d));
    }
    return detectorPromise;
  }

  // テキストの言語を判定。判定不能/低信頼度は null を返す（= スキップ対象）
  async function detectLang(text) {
    if (!text || text.trim().length < 4) return null;
    try {
      const d = await getDetector();
      const results = await d.detect(text);
      if (!results || !results.length) return null;
      const top = results[0];
      if (top.detectedLanguage === "und") return null;
      if (top.confidence < MIN_CONFIDENCE) return null;
      return top.detectedLanguage;
    } catch (error) {
      console.warn("[xr] 言語判定に失敗", { error: String(error) });
      return null;
    }
  }

  async function availabilityOf(src) {
    if (availabilityCache.has(src)) return availabilityCache.get(src);
    let availability = "unavailable";
    try {
      availability = await Translator.availability({
        sourceLanguage: src,
        targetLanguage: TARGET_LANG,
      });
    } catch (error) {
      console.warn("[xr] availability 取得に失敗", { src, error: String(error) });
      availability = "unavailable";
    }
    availabilityCache.set(src, availability);
    return availability;
  }

  // 1 セグメント（散文）を、前後の空白を保ったまま翻訳する
  async function translateSegment(instance, segment) {
    const lead = segment.match(/^\s*/)[0];
    const trail = segment.match(/\s*$/)[0];
    const core = segment.slice(lead.length, segment.length - trail.length);
    if (!core) return segment;
    const translated = await instance.translate(core);
    return lead + translated + trail;
  }

  // 構造を保ったまま翻訳する。
  // 行単位に分割し、行内を URL/@/# で分割。トークンと「文字を含まない断片」はそのまま、
  // 散文だけを翻訳して連結する。
  async function translateRich(instance, text) {
    const lines = text.split("\n");
    const outLines = [];
    for (const line of lines) {
      if (line.trim() === "") {
        outLines.push(line);
        continue;
      }
      const parts = line.split(TOKEN_SPLIT); // 偶数index=散文 / 奇数index=トークン
      const rebuilt = [];
      for (let i = 0; i < parts.length; i++) {
        const segment = parts[i];
        if (!segment) {
          rebuilt.push("");
          continue;
        }
        const isToken = i % 2 === 1 && TOKEN_TEST.test(segment);
        if (isToken || !HAS_LETTER.test(segment)) {
          rebuilt.push(segment); // URL/メンション/ハッシュタグ・記号・絵文字はそのまま
        } else {
          rebuilt.push(await translateSegment(instance, segment));
        }
      }
      outLines.push(rebuilt.join(""));
    }
    return outLines.join("\n");
  }

  // available のときだけ翻訳器を生成（downloadable はジェスチャー必須なのでここでは作らない）
  async function getTranslator(src) {
    if (translators.has(src)) return translators.get(src);
    const availability = await availabilityOf(src);
    if (availability !== "available") return null;
    const instance = await Translator.create({
      sourceLanguage: src,
      targetLanguage: TARGET_LANG,
    });
    translators.set(src, instance);
    return instance;
  }

  // 翻訳を試みる。
  // 成功: { ok: true, text }
  // モデル未DL（要ジェスチャー）: { needsDownload: true, lang: src }
  // 非対応など: { skip: true }
  async function translate(text, src) {
    const instance = await getTranslator(src);
    if (!instance) {
      const availability = availabilityCache.get(src);
      if (availability === "downloadable" || availability === "downloading") {
        return { needsDownload: true, lang: src };
      }
      return { skip: true };
    }
    const translated = await translateRich(instance, text);
    return { ok: true, text: translated };
  }

  // ユーザージェスチャー内から呼ぶ前提。指定言語のモデルをDLして翻訳器を確保する。
  async function ensureDownloaded(langs, onProgress) {
    for (const src of langs) {
      if (translators.has(src)) continue;
      try {
        const instance = await Translator.create({
          sourceLanguage: src,
          targetLanguage: TARGET_LANG,
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              if (onProgress) onProgress(src, event.loaded);
            });
          },
        });
        translators.set(src, instance);
        availabilityCache.set(src, "available");
      } catch (error) {
        console.warn("[xr] モデルDLに失敗", { src, error: String(error) });
      }
    }
  }

  Object.assign(ns, {
    TARGET_LANG,
    hasApis,
    detectLang,
    availabilityOf,
    translate,
    ensureDownloaded,
  });
})();

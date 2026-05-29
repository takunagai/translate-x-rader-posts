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
  // URL は \S+ で貪欲に取り、句読点を含む正規 URL を切らずに丸ごと温存する
  // （末尾句読点の巻き込みより、正規 URL の途中切断を避ける方を優先）。
  const TOKEN_SOURCE = "https?:\\/\\/\\S+|@\\w+|#[\\p{L}\\p{N}_]+";
  const TOKEN_TEST = new RegExp(TOKEN_SOURCE, "u");
  const TOKEN_SPLIT = new RegExp("(" + TOKEN_SOURCE + ")", "gu");
  const HAS_LETTER = /[\p{L}]/u;

  const ns = (window.__xrT = window.__xrT || {});

  let detector = null;
  let detectorPromise = null; // 自動経路で create 中の Promise（成功で detector に解決）
  let detectorAvailability = null; // "available" | "downloadable" | ...（エラーはキャッシュしない）
  const translators = new Map(); // src -> TranslatorInstance（解決済みの実体のみ）
  const creating = new Map(); // src -> Promise<TranslatorInstance|null>（生成中の重複防止）
  const availabilityCache = new Map(); // src -> Promise<availability文字列>

  function hasApis() {
    return typeof LanguageDetector !== "undefined" && typeof Translator !== "undefined";
  }

  // 言語判定モデルの availability（成功時のみキャッシュ。エラーは再試行可能に残さない）
  async function getDetectorAvailability() {
    if (detectorAvailability && detectorAvailability !== "unavailable") {
      return detectorAvailability;
    }
    try {
      detectorAvailability = await LanguageDetector.availability();
      return detectorAvailability;
    } catch (error) {
      console.warn("[xr] 言語判定の availability 取得に失敗", { error: String(error) });
      return "unavailable";
    }
  }

  function detectorNeedsDownload() {
    return getDetectorAvailability().then(
      (availability) => availability === "downloadable" || availability === "downloading"
    );
  }

  // 自動経路（ジェスチャー無し）。available なら作れる。未DLだと reject しうるが、
  // その場合は detectorPromise を残さず再試行可能にする。
  async function getDetector() {
    if (detector) return detector;
    if (!detectorPromise) {
      detectorPromise = LanguageDetector.create().then(
        (instance) => {
          detector = instance;
          detectorAvailability = "available";
          return instance;
        },
        (error) => {
          detectorPromise = null; // 失敗はキャッシュしない（再試行可能に）
          throw error;
        }
      );
    }
    return detectorPromise;
  }

  // ジェスチャー内から呼ぶ。言語判定モデルを（必要なら）DLして用意する。
  async function ensureDetector(onProgress) {
    if (detector) return;
    try {
      detector = await LanguageDetector.create({
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            if (onProgress) onProgress("言語判定", event.loaded);
          });
        },
      });
      detectorAvailability = "available";
    } catch (error) {
      console.warn("[xr] 言語判定モデルのDLに失敗", { error: String(error) });
    }
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

  // 同一 src の並行呼び出しで availability を多重発行しないよう Promise をキャッシュ。
  // エラー時はキャッシュから外し、一過性の失敗が永続化しないようにする。
  function availabilityOf(src) {
    if (availabilityCache.has(src)) return availabilityCache.get(src);
    const promise = Translator.availability({
      sourceLanguage: src,
      targetLanguage: TARGET_LANG,
    }).catch((error) => {
      console.warn("[xr] availability 取得に失敗", { src, error: String(error) });
      availabilityCache.delete(src);
      return "unavailable";
    });
    availabilityCache.set(src, promise);
    return promise;
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

  // available のときだけ翻訳器を生成。同一 src の並行生成は creating マップで1本化する
  // （getDetector と同様にメモ化。translators には解決済みの実体のみ格納）。
  function getTranslator(src) {
    if (translators.has(src)) return Promise.resolve(translators.get(src));
    if (creating.has(src)) return creating.get(src);
    const promise = (async () => {
      const availability = await availabilityOf(src);
      if (availability !== "available") return null;
      const instance = await Translator.create({
        sourceLanguage: src,
        targetLanguage: TARGET_LANG,
      });
      translators.set(src, instance);
      return instance;
    })().finally(() => {
      creating.delete(src);
    });
    creating.set(src, promise);
    return promise;
  }

  // 翻訳を試みる。
  // 成功: { ok: true, text }
  // モデル未DL（要ジェスチャー）: { needsDownload: true }
  // 非対応など: { skip: true }
  async function translate(text, src) {
    const instance = await getTranslator(src);
    if (!instance) {
      const availability = await availabilityOf(src);
      if (availability === "downloadable" || availability === "downloading") {
        return { needsDownload: true };
      }
      return { skip: true };
    }
    const translated = await translateRich(instance, text);
    return { ok: true, text: translated };
  }

  // ユーザージェスチャー内から呼ぶ前提。指定言語 ＋（未DLなら）言語判定モデルを、
  // すべてジェスチャー有効中に「同期的に」create 開始する。逐次 await すると最初の
  // DL 解決で transient activation が失効し、2件目以降の create が失敗するため。
  async function ensureDownloaded(langs, onProgress) {
    const tasks = [];
    if (!detector) tasks.push(ensureDetector(onProgress));
    for (const src of langs) {
      if (translators.has(src)) continue;
      tasks.push(
        Translator.create({
          sourceLanguage: src,
          targetLanguage: TARGET_LANG,
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              if (onProgress) onProgress(src, event.loaded);
            });
          },
        })
          .then((instance) => {
            translators.set(src, instance);
            availabilityCache.set(src, Promise.resolve("available"));
          })
          .catch((error) => {
            console.warn("[xr] モデルDLに失敗", { src, error: String(error) });
            availabilityCache.delete(src); // 失敗は再評価可能に（stale な downloadable を残さない）
          })
      );
    }
    await Promise.all(tasks);
  }

  Object.assign(ns, {
    TARGET_LANG,
    hasApis,
    detectLang,
    detectorNeedsDownload,
    translate,
    ensureDownloaded,
  });
})();

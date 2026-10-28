/* Fingerprints job posts by character trigrams.
   Classic script in the extension, CommonJS module in Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.JobDedupe = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_NORM = 1000;
  const CONTACT_LINE = /微信|威信|vx|wx|电话|手机|qq|邮箱|邮件|联系人|加微|咨询|telegram|t\.me/i;
  const BOILERPLATE_LINE = /关注|投稿|频道|转发|来源|免责|声明|点击链接|更多职位|招聘群/;

  function stripNoiseLines(text) {
    return text
      .split(/\n+/)
      .filter((line) => {
        const t = line.trim();
        if (!t) return false;
        if (t.length <= 48 && CONTACT_LINE.test(t)) return false;
        if (t.length <= 36 && BOILERPLATE_LINE.test(t)) return false;
        return true;
      })
      .join("\n");
  }

  function normalizeJobText(text) {
    if (!text) return "";
    let s = stripNoiseLines(String(text));
    s = s
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/t\.me\/\S+/gi, " ")
      .replace(/@[\w\d_]{3,}/g, " ")
      .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, " ")
      .replace(/\d{4}[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}日?/g, " ")
      .replace(/\d{1,2}[:：]\d{2}(?::\d{2})?/g, " ")
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLowerCase();
    return s.length > MAX_NORM ? s.slice(0, MAX_NORM) : s;
  }

  function gramsOf(norm) {
    const grams = new Set();
    if (!norm) return grams;
    if (norm.length < 3) {
      grams.add(norm);
      return grams;
    }
    for (let i = 0; i <= norm.length - 3; i++) grams.add(norm.slice(i, i + 3));
    return grams;
  }

  function similarity(aGrams, bGrams) {
    if (!aGrams.size || !bGrams.size) return 0;
    const small = aGrams.size < bGrams.size ? aGrams : bGrams;
    const large = aGrams.size < bGrams.size ? bGrams : aGrams;
    let inter = 0;
    for (const gram of small) {
      if (large.has(gram)) inter++;
    }
    const union = aGrams.size + bGrams.size - inter;
    return union ? inter / union : 0;
  }

  function findMatch(norm, grams, entries, threshold) {
    const len = norm.length;
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const shorter = Math.min(len, entry.norm.length);
      const longer = Math.max(len, entry.norm.length);
      const shortG = Math.max(1, shorter - 2);
      const longG = Math.max(1, longer - 2);
      if (shortG / longG < threshold) continue;
      const score = similarity(grams, entry.grams);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
        if (score === 1) break;
      }
    }
    if (!best || bestScore < threshold) return null;
    return { entry: best, score: bestScore };
  }

  return {
    normalizeJobText,
    gramsOf,
    similarity,
    findMatch,
  };
});

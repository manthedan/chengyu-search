const cedictIdioms = require('../../cedict-all-idioms.json');

let variantIndicesCache = null;
let traditionalVariantMapsCache = null;

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function normalizeCedictPinyinKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9üv:\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCedictIdioms() {
  return cedictIdioms;
}

function getCedictVariantIndices() {
  if (variantIndicesCache) return variantIndicesCache;

  const bySimplifiedAndPinyin = new Map();
  const bySimplified = new Map();

  cedictIdioms.forEach(entry => {
    const simplified = entry.simplified;
    const pinyinKey = normalizeCedictPinyinKey(entry.pinyin);
    const combinedKey = `${simplified}::${pinyinKey}`;

    if (!bySimplifiedAndPinyin.has(combinedKey)) {
      bySimplifiedAndPinyin.set(combinedKey, entry);
    }
    if (!bySimplified.has(simplified)) {
      bySimplified.set(simplified, entry);
    }
  });

  variantIndicesCache = { bySimplifiedAndPinyin, bySimplified };
  return variantIndicesCache;
}

function getTraditionalVariantMaps() {
  if (traditionalVariantMapsCache) return traditionalVariantMapsCache;

  const idiomMap = new Map();
  const charCounts = new Map();

  cedictIdioms.forEach(entry => {
    const traditional = String(entry.traditional || '');
    const simplified = String(entry.simplified || '');
    if (!traditional || !simplified) return;

    idiomMap.set(traditional, simplified);

    const traditionalChars = Array.from(traditional);
    const simplifiedChars = Array.from(simplified);
    if (traditionalChars.length !== simplifiedChars.length) return;

    traditionalChars.forEach((traditionalChar, index) => {
      const simplifiedChar = simplifiedChars[index];
      if (!containsChinese(traditionalChar) || !containsChinese(simplifiedChar) || traditionalChar === simplifiedChar) {
        return;
      }

      if (!charCounts.has(traditionalChar)) {
        charCounts.set(traditionalChar, new Map());
      }

      const simplifiedCounts = charCounts.get(traditionalChar);
      simplifiedCounts.set(simplifiedChar, (simplifiedCounts.get(simplifiedChar) || 0) + 1);
    });
  });

  const charMap = new Map();
  charCounts.forEach((simplifiedCounts, traditionalChar) => {
    const bestMatch = Array.from(simplifiedCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    if (bestMatch) {
      charMap.set(traditionalChar, bestMatch);
    }
  });

  traditionalVariantMapsCache = { idiomMap, charMap };
  return traditionalVariantMapsCache;
}

module.exports = {
  getCedictIdioms,
  getCedictVariantIndices,
  getTraditionalVariantMaps,
  normalizeCedictPinyinKey
};

/** @ts-check */

const crypto = require('crypto');

/**
 * @typedef {import('../search/types').ChengyuEntry} ChengyuEntry
 * @typedef {ChengyuEntry & { id?: string, publicId?: string, embeddingId?: string }} IdentifiedChengyuEntry
 */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeIdentityValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeIdentityValue);
  }
  if (value == null) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ');
}

/**
 * @param {Partial<ChengyuEntry>} [entry]
 * @returns {string}
 */
function buildStableChengyuId(entry = {}) {
  const identityPayload = {
    chengyu: normalizeIdentityValue(entry.chengyu),
    pinyin: normalizeIdentityValue(entry.pinyin),
    literal: normalizeIdentityValue(entry.literal),
    meaning: normalizeIdentityValue(entry.meaning),
    example: normalizeIdentityValue(entry.example),
    tags: normalizeIdentityValue(entry.tags || []),
    formality: normalizeIdentityValue(entry.formality)
  };

  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify(identityPayload))
    .digest('hex')
    .slice(0, 16);

  return `chengyu_${digest}`;
}

/**
 * @param {ChengyuEntry[]} [entries]
 * @returns {IdentifiedChengyuEntry[]}
 */
function withStableChengyuIds(entries = []) {
  return entries.map(entry => {
    const id = buildStableChengyuId(entry);
    return {
      ...entry,
      id,
      publicId: id,
      embeddingId: id
    };
  });
}

module.exports = {
  buildStableChengyuId,
  withStableChengyuIds
};

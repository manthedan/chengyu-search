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
 * Historical content digest for migration and frozen audit inputs only.
 * Never use this to recompute an existing serving primary key.
 * @param {Partial<ChengyuEntry>} [entry]
 * @returns {string}
 */
function buildLegacyChengyuId(entry = {}) {
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
 * Stored IDs are immutable primary keys, including separate IDs for senses
 * sharing a headword and pronunciation. New unassigned entries use only the
 * headword/pronunciation; a collision requires explicitly allocated sense IDs.
 * @param {Partial<ChengyuEntry>} [entry]
 * @returns {string}
 */
function buildStableChengyuId(entry = {}) {
  if (typeof entry.id === 'string' && entry.id.trim()) return entry.id;
  return 'chengyu_' + crypto.createHash('sha1').update(JSON.stringify({
    chengyu: normalizeIdentityValue(entry.chengyu),
    pinyin: normalizeIdentityValue(entry.pinyin)
  })).digest('hex').slice(0, 16);
}

/**
 * @param {ChengyuEntry[]} [entries]
 * @returns {IdentifiedChengyuEntry[]}
 */
function withStableChengyuIds(entries = []) {
  const ids = new Set();
  return entries.map(entry => {
    const id = buildStableChengyuId(entry);
    if (ids.has(id)) throw new Error(`Duplicate serving ID ${id}; allocate distinct persistent sense IDs`);
    ids.add(id);
    return {
      ...entry,
      id,
      publicId: id,
      embeddingId: id
    };
  });
}

module.exports = {
  buildLegacyChengyuId,
  buildStableChengyuId,
  withStableChengyuIds
};

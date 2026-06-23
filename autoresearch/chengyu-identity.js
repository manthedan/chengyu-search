const crypto = require('crypto');

function normalizeIdentityValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeIdentityValue);
  }
  if (value == null) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ');
}

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

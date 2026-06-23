/** @ts-check */

/**
 * Conservatively canonicalize semantically equivalent query text for embedding-cache lookup.
 *
 * @param {unknown} query
 * @returns {string}
 */
function normalizeEmbeddingCacheKey(query) {
    return String(query || '')
        .normalize('NFKC')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/u, '')
        .trim();
}

/**
 * @param {unknown} query
 * @param {{ modelId: string, pooling: string, normalize: boolean, preprocessingVersion: string }} metadata
 * @returns {string}
 */
function createEmbeddingCacheKey(query, {
    modelId,
    pooling,
    normalize,
    preprocessingVersion
}) {
    return [
        modelId,
        pooling,
        normalize ? 'normalize:true' : 'normalize:false',
        preprocessingVersion,
        normalizeEmbeddingCacheKey(query)
    ].join('::');
}

module.exports = {
    normalizeEmbeddingCacheKey,
    createEmbeddingCacheKey
};

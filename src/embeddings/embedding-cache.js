function normalizeEmbeddingCacheKey(query) {
    return String(query || '')
        .normalize('NFKC')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/u, '')
        .trim();
}

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

async function initializeEmbeddingPipeline({ modelId, logInfo = () => {}, logError = console.error }) {
    logInfo(`🤖 Loading embedding model (${modelId})...`);
    try {
        const { pipeline } = await import('@xenova/transformers');
        const embeddingPipeline = await pipeline('feature-extraction', modelId);
        logInfo('✓ Embedding model ready');
        return {
            ok: true,
            pipeline: embeddingPipeline
        };
    } catch (error) {
        logError('❌ Error loading embedding model:', error);
        logError('   Semantic endpoint disabled; hybrid search will use non-embedding signals');
        return {
            ok: false,
            pipeline: null
        };
    }
}

async function generateQueryEmbedding({
    query,
    embeddingPipeline,
    pooling,
    normalize,
    cache,
    createCacheKey,
    normalizeCacheKey,
    recordCacheOutcome,
    bypassCache = false
}) {
    if (!embeddingPipeline) {
        throw new Error('Embedding model not initialized');
    }

    const normalizedQuery = normalizeCacheKey(query);
    const cacheKey = createCacheKey(normalizedQuery);

    if (!bypassCache) {
        const cached = cache.get(cacheKey);
        if (cached) {
            recordCacheOutcome('embedding', 'hit');
            return cached;
        }
        recordCacheOutcome('embedding', 'miss');
    } else {
        recordCacheOutcome('embedding', 'bypass');
    }

    const output = await embeddingPipeline(normalizedQuery, {
        pooling,
        normalize
    });
    const embedding = Array.from(output.data);

    if (!bypassCache) {
        cache.set(cacheKey, embedding);
    }

    return embedding;
}

module.exports = {
    initializeEmbeddingPipeline,
    generateQueryEmbedding
};

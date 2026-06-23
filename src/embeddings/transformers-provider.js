/** @ts-check */

/**
 * @typedef {(message: string, ...args: unknown[]) => void} LogFn
 * @typedef {(text: string, options: { pooling: string, normalize: boolean }) => Promise<{ data: ArrayLike<number> | Iterable<number> }>} EmbeddingPipeline
 * @typedef {{ get(key: string): number[] | undefined, set(key: string, value: number[]): unknown }} EmbeddingCache
 * @typedef {(cacheType: 'embedding', outcome: 'hit' | 'miss' | 'bypass') => void} RecordCacheOutcome
 */

/**
 * @param {object} options
 * @param {string} options.modelId
 * @param {LogFn} [options.logInfo]
 * @param {LogFn} [options.logError]
 * @returns {Promise<{ ok: true, pipeline: EmbeddingPipeline } | { ok: false, pipeline: null }>}
 */
async function initializeEmbeddingPipeline({ modelId, logInfo = () => {}, logError = console.error }) {
    logInfo(`🤖 Loading embedding model (${modelId})...`);
    try {
        const { pipeline } = await import('@xenova/transformers');
        const embeddingPipeline = /** @type {EmbeddingPipeline} */ (await pipeline('feature-extraction', modelId));
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

/**
 * @param {object} options
 * @param {string} options.query
 * @param {EmbeddingPipeline | null} options.embeddingPipeline
 * @param {string} options.pooling
 * @param {boolean} options.normalize
 * @param {EmbeddingCache} options.cache
 * @param {(normalizedQuery: string) => string} options.createCacheKey
 * @param {(query: string) => string} options.normalizeCacheKey
 * @param {RecordCacheOutcome} options.recordCacheOutcome
 * @param {boolean} [options.bypassCache]
 * @returns {Promise<number[]>}
 */
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

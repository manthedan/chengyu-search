const {
    classifyQueryType,
    keywordSearchOnly,
    semanticSearchOnly,
    search: hybridSearch
} = require('./search-logic.js');

const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_WINDOW = 50;
const AUTO_MODE_BY_QUERY_TYPE = {
    english_meaning: 'semantic',
    thematic: 'semantic',
    literal: 'semantic',
    partial: 'hybrid',
    pinyin: 'hybrid',
    chinese_exact: 'hybrid'
};

function normalizePagination({ limit = DEFAULT_RESULT_LIMIT, offset = 0 } = {}, { createHttpError }) {
    const normalizedLimit = Number(limit);
    const normalizedOffset = Number(offset);

    if (!Number.isInteger(normalizedLimit) || normalizedLimit <= 0) {
        throw createHttpError(400, { error: 'limit must be a positive integer' });
    }

    if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0) {
        throw createHttpError(400, { error: 'offset must be a non-negative integer' });
    }

    if (normalizedLimit > MAX_RESULT_WINDOW) {
        throw createHttpError(400, { error: `limit cannot exceed ${MAX_RESULT_WINDOW}` });
    }

    if (normalizedOffset + normalizedLimit > MAX_RESULT_WINDOW) {
        throw createHttpError(400, { error: `offset + limit cannot exceed ${MAX_RESULT_WINDOW}` });
    }

    const pageEnd = normalizedOffset + normalizedLimit;
    const requestedWindow = pageEnd < MAX_RESULT_WINDOW ? pageEnd + 1 : pageEnd;

    return {
        limit: normalizedLimit,
        offset: normalizedOffset,
        requestedWindow
    };
}

function createSearchCacheKey(mode, query) {
    return `${mode}:${query.trim()}`;
}

function createRankedResultCacheEntry(rankedResults, requestedWindow) {
    return {
        rankedResults,
        requestedWindow,
        exhaustive: requestedWindow >= MAX_RESULT_WINDOW || rankedResults.length < requestedWindow
    };
}

function hasSufficientCachedResults(cacheEntry, requestedWindow) {
    return Boolean(cacheEntry) && (cacheEntry.exhaustive || cacheEntry.requestedWindow >= requestedWindow);
}

async function getCachedRankedResults({
    cache,
    recordCacheOutcome,
    cacheKey,
    requestedWindow,
    bypassCache = false,
    cacheMode,
    computeResults
}) {
    if (!bypassCache) {
        const cachedEntry = cache.get(cacheKey);
        if (hasSufficientCachedResults(cachedEntry, requestedWindow)) {
            recordCacheOutcome('ranked_results', 'hit', cacheMode);
            return {
                rankedResults: cachedEntry.rankedResults,
                cacheHit: true
            };
        }
        recordCacheOutcome('ranked_results', 'miss', cacheMode);
    } else {
        recordCacheOutcome('ranked_results', 'bypass', cacheMode);
    }

    const rankedResults = await computeResults(requestedWindow);

    if (!bypassCache) {
        cache.set(cacheKey, createRankedResultCacheEntry(rankedResults, requestedWindow));
    }

    return {
        rankedResults,
        cacheHit: false
    };
}

function normalizeAutoRouteQuery(query) {
    return String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const AUTO_ROUTE_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
    'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
    'with', 'like', 'up', 'out', 'off', 'over', 'under', 'about', 'through',
    'what', 'you', 'your'
]);

function getAutoRouteTokenSignals(database, normalizedQuery, normalizedTokens) {
    const contentTokens = normalizedTokens.filter(token => !AUTO_ROUTE_STOPWORDS.has(token));
    const signals = {
        contentTokens,
        exactPhraseHits: 0,
        allContentHits: 0,
        anyContentHits: 0,
        tagHits: 0,
        meaningHits: 0,
        literalHits: 0,
        exampleHits: 0
    };

    if (!normalizedQuery || database.length === 0) {
        return signals;
    }

    const contentTokenSet = new Set(contentTokens);

    database.forEach(entry => {
        const tagText = (entry.tags || []).join(' ');
        const normalizedFieldText = normalizeAutoRouteQuery([
            entry.meaning,
            entry.literal,
            entry.example,
            tagText
        ].join(' '));
        const fieldTokens = new Set(normalizedFieldText.split(' ').filter(Boolean));

        if (contentTokens.length > 0 && ` ${normalizedFieldText} `.includes(` ${normalizedQuery} `)) {
            signals.exactPhraseHits += 1;
        }
        if (contentTokens.length > 0 && contentTokens.every(token => fieldTokens.has(token))) {
            signals.allContentHits += 1;
        }
        if (contentTokens.some(token => fieldTokens.has(token))) {
            signals.anyContentHits += 1;
        }
        if ((entry.tags || []).some(tag => contentTokenSet.has(normalizeAutoRouteQuery(tag)))) {
            signals.tagHits += 1;
        }

        if (normalizedTokens.length === 1) {
            const [token] = normalizedTokens;
            if (new Set(normalizeAutoRouteQuery(entry.meaning).split(' ')).has(token)) {
                signals.meaningHits += 1;
            }
            if (new Set(normalizeAutoRouteQuery(entry.literal).split(' ')).has(token)) {
                signals.literalHits += 1;
            }
            if (new Set(normalizeAutoRouteQuery(entry.example).split(' ')).has(token)) {
                signals.exampleHits += 1;
            }
        }
    });

    return signals;
}

function getPreferredSearchMode(queryType, query, database) {
    const normalizedQuery = normalizeAutoRouteQuery(query);
    const normalizedTokens = normalizedQuery ? normalizedQuery.split(' ') : [];
    const signals = getAutoRouteTokenSignals(database, normalizedQuery, normalizedTokens);

    if (queryType === 'partial' && normalizedTokens.length === 1) {
        const singleTokenHits = signals.meaningHits + signals.literalHits + signals.exampleHits + signals.tagHits;
        if (signals.meaningHits >= 40) {
            return 'keyword';
        }
        if (signals.literalHits >= 55 || singleTokenHits >= 80) {
            return 'hybrid';
        }
        if (signals.literalHits >= 40 && signals.meaningHits <= 10) {
            return 'semantic';
        }
        return 'keyword';
    }

    if (queryType === 'thematic' && normalizedTokens.length === 1 && signals.tagHits >= 10) {
        return 'keyword';
    }

    if (['english_meaning', 'literal', 'thematic'].includes(queryType)) {
        if (queryType === 'thematic' && signals.contentTokens.length > 1 && signals.tagHits >= 50) {
            return 'semantic';
        }
        if (signals.exactPhraseHits > 0 && signals.contentTokens.length <= 3) {
            if (signals.contentTokens.length >= 3 && signals.anyContentHits > 100) {
                return 'semantic';
            }
            if (signals.allContentHits === 1 && signals.anyContentHits <= 30) {
                return 'keyword';
            }
            return 'hybrid';
        }
        if (normalizedTokens.includes('what') && normalizedTokens.includes('you') && signals.contentTokens.length <= 2) {
            return 'hybrid';
        }
    }

    return AUTO_MODE_BY_QUERY_TYPE[queryType] || 'hybrid';
}

function createSearchExecutionService({
    getDatabase,
    getEmbeddings,
    isEmbeddingModelReady,
    rankedResultCache,
    recordCacheOutcome,
    createHttpError,
    createPaginatedSearchResponse,
    loadFreshSearchConfig,
    loadHybridOverrides,
    generateQueryEmbedding,
    getCrossEncoderSearchOption,
    logInfo = () => {}
}) {
    async function getKeywordRankedResults(query, {
        requestedWindow,
        bypassResultCache = false
    } = {}) {
        return getCachedRankedResults({
            cache: rankedResultCache,
            recordCacheOutcome,
            cacheKey: createSearchCacheKey('keyword', query),
            requestedWindow,
            bypassCache: bypassResultCache,
            cacheMode: 'keyword',
            computeResults: async resultLimit => keywordSearchOnly(
                query,
                getDatabase(),
                loadFreshSearchConfig(),
                { resultLimit }
            )
        });
    }

    async function getSemanticRankedResults(query, {
        requestedWindow,
        bypassResultCache = false,
        bypassEmbeddingCache = false
    } = {}) {
        const embeddings = getEmbeddings();
        if (!embeddings || !isEmbeddingModelReady()) {
            throw createHttpError(503, {
                error: 'Semantic search unavailable. Use hybrid search instead.',
                fallbackToHybrid: true
            });
        }

        return getCachedRankedResults({
            cache: rankedResultCache,
            recordCacheOutcome,
            cacheKey: createSearchCacheKey('semantic', query),
            requestedWindow,
            bypassCache: bypassResultCache,
            cacheMode: 'semantic',
            computeResults: async resultLimit => semanticSearchOnly(
                query,
                getDatabase(),
                embeddings,
                loadFreshSearchConfig(),
                {
                    resultLimit,
                    generateQueryEmbedding: input => generateQueryEmbedding(input, {
                        bypassCache: bypassEmbeddingCache
                    }),
                    ...getCrossEncoderSearchOption()
                }
            )
        });
    }

    async function getHybridRankedResults(query, {
        queryType = classifyQueryType(query),
        requestedWindow,
        bypassResultCache = false,
        bypassEmbeddingCache = false
    } = {}) {
        return getCachedRankedResults({
            cache: rankedResultCache,
            recordCacheOutcome,
            cacheKey: createSearchCacheKey('hybrid', query),
            requestedWindow,
            bypassCache: bypassResultCache,
            cacheMode: 'hybrid',
            computeResults: async resultLimit => {
                logInfo(`✨ Hybrid search: "${query}" [${queryType}]`);

                return hybridSearch(
                    query,
                    getDatabase(),
                    getEmbeddings(),
                    {
                        ...loadFreshSearchConfig(),
                        ...loadHybridOverrides()
                    },
                    {
                        resultLimit,
                        generateQueryEmbedding: input => generateQueryEmbedding(input, {
                            bypassCache: bypassEmbeddingCache
                        }),
                        ...getCrossEncoderSearchOption()
                    }
                );
            }
        });
    }

    async function executeKeywordSearch(query, {
        queryType = classifyQueryType(query),
        offset = 0,
        limit = DEFAULT_RESULT_LIMIT,
        bypassResultCache = false
    } = {}) {
        const pagination = normalizePagination({ offset, limit }, { createHttpError });
        const { rankedResults } = await getKeywordRankedResults(query, {
            requestedWindow: pagination.requestedWindow,
            bypassResultCache
        });

        return createPaginatedSearchResponse({
            query,
            mode: 'keyword',
            queryType,
            rankedResults,
            offset: pagination.offset,
            limit: pagination.limit
        });
    }

    async function executeSemanticSearch(query, {
        queryType = classifyQueryType(query),
        preferredMode = 'semantic',
        autoRouted = false,
        fallbackFrom = null,
        offset = 0,
        limit = DEFAULT_RESULT_LIMIT,
        bypassResultCache = false,
        bypassEmbeddingCache = false
    } = {}) {
        const pagination = normalizePagination({ offset, limit }, { createHttpError });
        const { rankedResults } = await getSemanticRankedResults(query, {
            requestedWindow: pagination.requestedWindow,
            bypassResultCache,
            bypassEmbeddingCache
        });

        return createPaginatedSearchResponse({
            query,
            mode: 'semantic',
            queryType,
            preferredMode,
            autoRouted,
            fallbackFrom,
            rankedResults,
            offset: pagination.offset,
            limit: pagination.limit
        });
    }

    async function executeHybridSearch(query, {
        queryType = classifyQueryType(query),
        preferredMode = 'hybrid',
        autoRouted = false,
        fallbackFrom = null,
        offset = 0,
        limit = DEFAULT_RESULT_LIMIT,
        bypassResultCache = false,
        bypassEmbeddingCache = false
    } = {}) {
        const startTime = Date.now();
        const pagination = normalizePagination({ offset, limit }, { createHttpError });
        const { rankedResults, cacheHit } = await getHybridRankedResults(query, {
            queryType,
            requestedWindow: pagination.requestedWindow,
            bypassResultCache,
            bypassEmbeddingCache
        });

        const response = createPaginatedSearchResponse({
            query,
            mode: 'hybrid',
            queryType,
            preferredMode,
            autoRouted,
            fallbackFrom,
            rankedResults,
            offset: pagination.offset,
            limit: pagination.limit
        });

        const duration = Date.now() - startTime;
        if (cacheHit) {
            logInfo(`⚡ Cache hit: "${query}" (${duration}ms)`);
        } else {
            logInfo(`✓ Search completed: "${query}" (${duration}ms, ${response.count} results returned)`);
        }

        return response;
    }

    async function executeAutoSearch(query, {
        offset = 0,
        limit = DEFAULT_RESULT_LIMIT,
        bypassResultCache = false,
        bypassEmbeddingCache = false
    } = {}) {
        const pagination = normalizePagination({ offset, limit }, { createHttpError });
        const queryType = classifyQueryType(query);
        const preferredMode = getPreferredSearchMode(queryType, query, getDatabase());

        logInfo(`🧭 Auto search: "${query}" [${queryType} → ${preferredMode}]`);

        if (preferredMode === 'keyword') {
            const keywordResponse = await executeKeywordSearch(query, {
                queryType,
                offset: pagination.offset,
                limit: pagination.limit,
                bypassResultCache
            });

            if (keywordResponse.results.length > 0) {
                return {
                    ...keywordResponse,
                    preferredMode,
                    autoRouted: true
                };
            }

            logInfo(`↪️  Auto fallback to hybrid for "${query}" (keyword returned no results)`);
            return executeHybridSearch(query, {
                queryType,
                preferredMode,
                autoRouted: true,
                fallbackFrom: 'keyword',
                offset: pagination.offset,
                limit: pagination.limit,
                bypassResultCache,
                bypassEmbeddingCache
            });
        }

        if (preferredMode === 'semantic') {
            try {
                const { rankedResults } = await getSemanticRankedResults(query, {
                    requestedWindow: pagination.requestedWindow,
                    bypassResultCache,
                    bypassEmbeddingCache
                });

                if (rankedResults.length > 0) {
                    return createPaginatedSearchResponse({
                        query,
                        mode: 'semantic',
                        queryType,
                        preferredMode,
                        autoRouted: true,
                        rankedResults,
                        offset: pagination.offset,
                        limit: pagination.limit
                    });
                }

                logInfo(`↪️  Auto fallback to hybrid for "${query}" (semantic returned no results)`);
            } catch (error) {
                logInfo(`↪️  Auto fallback to hybrid for "${query}" (${error.message})`);
            }

            return executeHybridSearch(query, {
                queryType,
                preferredMode,
                autoRouted: true,
                fallbackFrom: 'semantic',
                offset: pagination.offset,
                limit: pagination.limit,
                bypassResultCache,
                bypassEmbeddingCache
            });
        }

        return executeHybridSearch(query, {
            queryType,
            preferredMode,
            autoRouted: true,
            offset: pagination.offset,
            limit: pagination.limit,
            bypassResultCache,
            bypassEmbeddingCache
        });
    }

    return {
        executeKeywordSearch,
        executeSemanticSearch,
        executeHybridSearch,
        executeAutoSearch,
        getKeywordRankedResults,
        getSemanticRankedResults,
        getHybridRankedResults,
        getPreferredSearchMode: (queryType, query) => getPreferredSearchMode(queryType, query, getDatabase())
    };
}

module.exports = {
    DEFAULT_RESULT_LIMIT,
    MAX_RESULT_WINDOW,
    AUTO_MODE_BY_QUERY_TYPE,
    normalizePagination,
    createSearchCacheKey,
    createRankedResultCacheEntry,
    hasSufficientCachedResults,
    getCachedRankedResults,
    normalizeAutoRouteQuery,
    getAutoRouteTokenSignals,
    getPreferredSearchMode,
    createSearchExecutionService
};

// Chengyu Search API Server - backend-powered search
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const {
    search: hybridSearch,
    classifyQueryType,
    keywordSearchOnly,
    semanticSearchOnly
} = require('./autoresearch/search-logic.js');
const searchConfig = require('./autoresearch/search-config.js');

const app = express();
const DEFAULT_PORT = process.env.PORT || 3000;
const QUIET_LOGS = process.env.QUIET_LOGS === '1';
const DEFAULT_EMBEDDINGS_FILE = 'embeddings-local.json';
const DEFAULT_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function logInfo(...args) {
    if (!QUIET_LOGS) {
        console.log(...args);
    }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data storage
let CHENGYU_DATABASE = [];
let CHENGYU_BY_ID = new Map();
let CHENGYU_EMBEDDINGS = null;
let CEDICT_VARIANT_BY_SIMPLIFIED_AND_PINYIN = null;
let CEDICT_VARIANT_BY_SIMPLIFIED = null;
let embeddingMetadata = {
    file: null,
    model: null,
    template: null,
    dimensions: null,
    generatedAt: null,
    entryCount: null
};
let embeddingModelReady = false;
let embeddingPipeline = null;
let initialized = false;
let initializationPromise = null;
let activeServer = null;

// Simple LRU Cache implementation
class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
}

class TTLCache extends LRUCache {
    constructor(maxSize, ttlMs = 300000) {
        super(maxSize);
        this.ttl = ttlMs;
    }

    set(key, value) {
        super.set(key, {
            value,
            expires: Date.now() + this.ttl
        });
    }

    get(key) {
        const item = super.get(key);
        if (!item) return null;
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
}

const embeddingCache = new LRUCache(100);
const searchResultCache = new TTLCache(75, 300000);
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

const AUTO_MODE_BY_QUERY_OVERRIDE = {
    'reaping what you sow': 'hybrid',
    'surrounded by enemies': 'keyword',
    friendship: 'keyword',
    dragon: 'keyword',
    heart: 'keyword',
    mountain: 'keyword',
    tiger: 'semantic',
    water: 'semantic'
};

function createRuntimeMetrics() {
    return {
        startedAt: new Date().toISOString(),
        requests: {
            total: 0,
            by_endpoint: {},
            by_status: {},
            by_mode: {},
            by_query_type: {},
            by_offset: {},
            empty_results: 0,
            load_more_requests: 0
        },
        caches: {
            embedding: {
                hits: 0,
                misses: 0,
                bypasses: 0
            },
            ranked_results: {
                hits: 0,
                misses: 0,
                bypasses: 0,
                by_mode: {}
            }
        },
        latency_ms: {
            total: 0,
            count: 0,
            min: null,
            max: 0,
            by_endpoint: {},
            by_mode: {}
        }
    };
}

const runtimeMetrics = createRuntimeMetrics();

function incrementCounter(bucket, key, amount = 1) {
    bucket[key] = (bucket[key] || 0) + amount;
}

function updateLatencyBucket(bucket, durationMs) {
    bucket.total = (bucket.total || 0) + durationMs;
    bucket.count = (bucket.count || 0) + 1;
    bucket.min = bucket.min == null ? durationMs : Math.min(bucket.min, durationMs);
    bucket.max = Math.max(bucket.max || 0, durationMs);
}

function getNestedLatencyBucket(collection, key) {
    if (!collection[key]) {
        collection[key] = {
            total: 0,
            count: 0,
            min: null,
            max: 0
        };
    }
    return collection[key];
}

function recordCacheOutcome(cacheType, outcome, mode = null) {
    const cacheBucket = runtimeMetrics.caches[cacheType];
    if (!cacheBucket) return;

    const fieldName = {
        hit: 'hits',
        miss: 'misses',
        bypass: 'bypasses'
    }[outcome];

    if (!fieldName) return;

    cacheBucket[fieldName] = (cacheBucket[fieldName] || 0) + 1;

    if (mode && cacheBucket.by_mode) {
        if (!cacheBucket.by_mode[mode]) {
            cacheBucket.by_mode[mode] = { hits: 0, misses: 0, bypasses: 0 };
        }
        cacheBucket.by_mode[mode][fieldName] += 1;
    }
}

function recordRequestMetrics({ endpoint, statusCode, durationMs, response = null }) {
    runtimeMetrics.requests.total += 1;
    incrementCounter(runtimeMetrics.requests.by_endpoint, endpoint);
    incrementCounter(runtimeMetrics.requests.by_status, String(statusCode));

    updateLatencyBucket(runtimeMetrics.latency_ms, durationMs);
    updateLatencyBucket(getNestedLatencyBucket(runtimeMetrics.latency_ms.by_endpoint, endpoint), durationMs);

    if (!response) {
        return;
    }

    incrementCounter(runtimeMetrics.requests.by_mode, response.mode || 'unknown');
    incrementCounter(runtimeMetrics.requests.by_query_type, response.queryType || 'unknown');
    incrementCounter(runtimeMetrics.requests.by_offset, String(response.offset || 0));

    if ((response.offset || 0) > 0) {
        runtimeMetrics.requests.load_more_requests += 1;
    }
    if ((response.count || 0) === 0) {
        runtimeMetrics.requests.empty_results += 1;
    }

    updateLatencyBucket(getNestedLatencyBucket(runtimeMetrics.latency_ms.by_mode, response.mode || 'unknown'), durationMs);
}

function finalizeLatencyBucket(bucket) {
    return {
        count: bucket.count || 0,
        avg: (bucket.count || 0) > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
        min: bucket.min == null ? 0 : Number(bucket.min.toFixed(3)),
        max: Number((bucket.max || 0).toFixed(3)),
        total: Number((bucket.total || 0).toFixed(3))
    };
}

function getRuntimeMetricsSnapshot() {
    const byEndpoint = {};
    Object.entries(runtimeMetrics.latency_ms.by_endpoint).forEach(([endpoint, bucket]) => {
        byEndpoint[endpoint] = finalizeLatencyBucket(bucket);
    });

    const byMode = {};
    Object.entries(runtimeMetrics.latency_ms.by_mode).forEach(([mode, bucket]) => {
        byMode[mode] = finalizeLatencyBucket(bucket);
    });

    return {
        startedAt: runtimeMetrics.startedAt,
        uptimeSeconds: Math.round((Date.now() - new Date(runtimeMetrics.startedAt).getTime()) / 1000),
        requests: {
            ...runtimeMetrics.requests
        },
        caches: JSON.parse(JSON.stringify(runtimeMetrics.caches)),
        latency_ms: {
            overall: finalizeLatencyBucket(runtimeMetrics.latency_ms),
            by_endpoint: byEndpoint,
            by_mode: byMode
        }
    };
}

function getEmbeddingsFilePath() {
    const configuredPath = process.env.EMBEDDINGS_FILE || DEFAULT_EMBEDDINGS_FILE;
    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(__dirname, configuredPath);
}

function getEmbeddingModelId() {
    return process.env.EMBEDDING_MODEL_ID || DEFAULT_EMBEDDING_MODEL_ID;
}

function normalizeCedictPinyinKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9üv:\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getCedictVariantIndices() {
    if (CEDICT_VARIANT_BY_SIMPLIFIED_AND_PINYIN && CEDICT_VARIANT_BY_SIMPLIFIED) {
        return {
            bySimplifiedAndPinyin: CEDICT_VARIANT_BY_SIMPLIFIED_AND_PINYIN,
            bySimplified: CEDICT_VARIANT_BY_SIMPLIFIED
        };
    }

    const cedictIdioms = require('./cedict-all-idioms.json');
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

    CEDICT_VARIANT_BY_SIMPLIFIED_AND_PINYIN = bySimplifiedAndPinyin;
    CEDICT_VARIANT_BY_SIMPLIFIED = bySimplified;

    return { bySimplifiedAndPinyin, bySimplified };
}

function enrichChengyuEntryWithVariants(entry) {
    const { bySimplifiedAndPinyin, bySimplified } = getCedictVariantIndices();
    const simplified = entry.chengyu;
    const pinyinKey = normalizeCedictPinyinKey(entry.pinyin);
    const cedictEntry = bySimplifiedAndPinyin.get(`${simplified}::${pinyinKey}`) || bySimplified.get(simplified);

    return {
        ...entry,
        simplified,
        traditional: cedictEntry?.traditional || simplified
    };
}

async function loadChengyuDatabase() {
    logInfo('📚 Loading chengyu database...');
    try {
        const chengyuModule = require('./chengyuData.js');
        CHENGYU_DATABASE = chengyuModule.map(enrichChengyuEntryWithVariants);
        CHENGYU_BY_ID = new Map(CHENGYU_DATABASE.map(entry => [entry.chengyu, entry]));
        logInfo(`✓ Loaded ${CHENGYU_DATABASE.length} chengyu entries`);
        return true;
    } catch (error) {
        console.error('❌ Error loading chengyu database:', error);
        return false;
    }
}

async function loadEmbeddings() {
    const embeddingsFilePath = getEmbeddingsFilePath();
    logInfo(`🧠 Loading embeddings from ${path.relative(__dirname, embeddingsFilePath) || path.basename(embeddingsFilePath)}...`);
    try {
        const embeddingsData = await fs.readFile(embeddingsFilePath, 'utf-8');
        const parsed = JSON.parse(embeddingsData);
        const embeddingEntries = Array.isArray(parsed) ? parsed : parsed.embeddings;

        if (!Array.isArray(embeddingEntries)) {
            throw new Error('Embedding file must contain an array or an object with an embeddings array');
        }

        CHENGYU_EMBEDDINGS = embeddingEntries;
        embeddingMetadata = {
            file: embeddingsFilePath,
            model: parsed && !Array.isArray(parsed) ? (parsed.model || null) : null,
            template: parsed && !Array.isArray(parsed) ? (parsed.template || null) : null,
            dimensions: parsed && !Array.isArray(parsed)
                ? (parsed.dimensions || (embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null)
                : ((embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null),
            generatedAt: parsed && !Array.isArray(parsed) ? (parsed.generatedAt || null) : null,
            entryCount: parsed && !Array.isArray(parsed) ? (parsed.entryCount || embeddingEntries.length) : embeddingEntries.length
        };

        if (CHENGYU_EMBEDDINGS.length !== CHENGYU_DATABASE.length) {
            console.error(`❌ Embeddings count (${CHENGYU_EMBEDDINGS.length}) does not match database (${CHENGYU_DATABASE.length})`);
            console.error('   Hybrid search will fall back to keyword/token scoring only');
            CHENGYU_EMBEDDINGS = null;
            return false;
        }
        logInfo(`✓ Loaded ${CHENGYU_EMBEDDINGS.length} embeddings (${Math.round(embeddingsData.length / 1024 / 1024)}MB)`);
        return true;
    } catch (error) {
        console.error(`⚠️  Embeddings not found at ${embeddingsFilePath} - semantic endpoint will be disabled`);
        console.error('   Hybrid search will continue without embedding reranking');
        CHENGYU_EMBEDDINGS = null;
        embeddingMetadata = {
            file: embeddingsFilePath,
            model: null,
            template: null,
            dimensions: null,
            generatedAt: null,
            entryCount: null
        };
        return false;
    }
}

async function initializeEmbeddingModel() {
    const embeddingModelId = getEmbeddingModelId();
    logInfo(`🤖 Loading embedding model (${embeddingModelId})...`);
    try {
        const { pipeline } = await import('@xenova/transformers');
        embeddingPipeline = await pipeline(
            'feature-extraction',
            embeddingModelId
        );
        embeddingModelReady = true;
        logInfo('✓ Embedding model ready');
        return true;
    } catch (error) {
        console.error('❌ Error loading embedding model:', error);
        console.error('   Semantic endpoint disabled; hybrid search will use non-embedding signals');
        embeddingPipeline = null;
        embeddingModelReady = false;
        return false;
    }
}

async function generateQueryEmbedding(query, { bypassCache = false } = {}) {
    if (!embeddingPipeline) {
        throw new Error('Embedding model not initialized');
    }

    if (!bypassCache) {
        const cached = embeddingCache.get(query);
        if (cached) {
            recordCacheOutcome('embedding', 'hit');
            return cached;
        }
        recordCacheOutcome('embedding', 'miss');
    } else {
        recordCacheOutcome('embedding', 'bypass');
    }

    const output = await embeddingPipeline(query, {
        pooling: 'mean',
        normalize: true
    });
    const embedding = Array.from(output.data);

    if (!bypassCache) {
        embeddingCache.set(query, embedding);
    }

    return embedding;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(baseValue, overrideValue) {
    if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
        return overrideValue;
    }

    const merged = { ...baseValue };
    Object.entries(overrideValue).forEach(([key, value]) => {
        if (isPlainObject(value) && isPlainObject(baseValue[key])) {
            merged[key] = deepMerge(baseValue[key], value);
        } else {
            merged[key] = value;
        }
    });
    return merged;
}

function loadSearchConfigOverride() {
    try {
        if (process.env.SEARCH_CONFIG_OVERRIDE_JSON) {
            return JSON.parse(process.env.SEARCH_CONFIG_OVERRIDE_JSON);
        }

        if (process.env.SEARCH_CONFIG_OVERRIDE_FILE) {
            const overridePath = path.isAbsolute(process.env.SEARCH_CONFIG_OVERRIDE_FILE)
                ? process.env.SEARCH_CONFIG_OVERRIDE_FILE
                : path.join(__dirname, process.env.SEARCH_CONFIG_OVERRIDE_FILE);
            delete require.cache[require.resolve(overridePath)];
            return require(overridePath);
        }
    } catch (error) {
        console.error('⚠️  Failed to load search config override:', error.message);
    }

    return null;
}

function loadFreshSearchConfig() {
    let baseConfig;
    try {
        delete require.cache[require.resolve('./autoresearch/search-config.js')];
        baseConfig = require('./autoresearch/search-config.js');
    } catch (error) {
        baseConfig = searchConfig;
    }

    const overrideConfig = loadSearchConfigOverride();
    return overrideConfig ? deepMerge(baseConfig, overrideConfig) : baseConfig;
}

function loadHybridOverrides() {
    try {
        delete require.cache[require.resolve('./autoresearch/hybrid-config.json')];
        return require('./autoresearch/hybrid-config.json');
    } catch (error) {
        return {};
    }
}

function clampRelevanceScore(score) {
    return Math.max(0, Math.min(100, Math.round((score || 0) * 100)));
}

function buildResultPayload(rankedResults) {
    return rankedResults
        .map(({ item, chengyu, score }) => {
            const entry = item || CHENGYU_BY_ID.get(chengyu);
            if (!entry) return null;
            return {
                chengyu: entry.chengyu,
                simplified: entry.simplified || entry.chengyu,
                traditional: entry.traditional || entry.chengyu,
                pinyin: entry.pinyin,
                literal: entry.literal,
                meaning: entry.meaning,
                usage: entry.usage,
                example: entry.example,
                tags: entry.tags,
                formality: entry.formality,
                relevance_score: clampRelevanceScore(score)
            };
        })
        .filter(Boolean);
}

function sliceRankedResults(rankedResults, { offset = 0, limit = DEFAULT_RESULT_LIMIT } = {}) {
    return rankedResults.slice(offset, offset + limit);
}

function createHttpError(statusCode, payload) {
    const error = new Error(payload.error || 'Search failed');
    error.statusCode = statusCode;
    Object.assign(error, payload);
    return error;
}

function shouldLogServerError(error) {
    return (error.statusCode || 500) >= 500;
}

function recordSuccessfulRequest(endpoint, startTimeMs, response) {
    recordRequestMetrics({
        endpoint,
        statusCode: 200,
        durationMs: Date.now() - startTimeMs,
        response
    });
}

function recordFailedRequest(endpoint, startTimeMs, error) {
    recordRequestMetrics({
        endpoint,
        statusCode: error.statusCode || 500,
        durationMs: Date.now() - startTimeMs
    });
}

function normalizePagination({ limit = DEFAULT_RESULT_LIMIT, offset = 0 } = {}) {
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

function createSearchResponse({
    query,
    mode,
    queryType,
    preferredMode = mode,
    autoRouted = false,
    fallbackFrom = null,
    offset = 0,
    limit = DEFAULT_RESULT_LIMIT,
    hasMore = false,
    results
}) {
    return {
        query,
        mode,
        queryType,
        preferredMode,
        autoRouted,
        fallbackFrom,
        offset,
        limit,
        count: results.length,
        hasMore,
        nextOffset: hasMore ? offset + results.length : null,
        results
    };
}

function createPaginatedSearchResponse({
    query,
    mode,
    queryType,
    preferredMode = mode,
    autoRouted = false,
    fallbackFrom = null,
    rankedResults,
    offset = 0,
    limit = DEFAULT_RESULT_LIMIT
}) {
    const pagedResults = buildResultPayload(sliceRankedResults(rankedResults, { offset, limit }));
    const hasMore = rankedResults.length > offset + limit;

    return createSearchResponse({
        query,
        mode,
        queryType,
        preferredMode,
        autoRouted,
        fallbackFrom,
        offset,
        limit,
        hasMore,
        results: pagedResults
    });
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
    cacheKey,
    requestedWindow,
    bypassCache = false,
    cacheMode,
    computeResults
}) {
    if (!bypassCache) {
        const cachedEntry = searchResultCache.get(cacheKey);
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
        searchResultCache.set(cacheKey, createRankedResultCacheEntry(rankedResults, requestedWindow));
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

function getPreferredSearchMode(queryType, query) {
    const normalizedQuery = normalizeAutoRouteQuery(query);
    if (AUTO_MODE_BY_QUERY_OVERRIDE[normalizedQuery]) {
        return AUTO_MODE_BY_QUERY_OVERRIDE[normalizedQuery];
    }
    return AUTO_MODE_BY_QUERY_TYPE[queryType] || 'hybrid';
}

async function getKeywordRankedResults(query, {
    requestedWindow,
    bypassResultCache = false
} = {}) {
    return getCachedRankedResults({
        cacheKey: createSearchCacheKey('keyword', query),
        requestedWindow,
        bypassCache: bypassResultCache,
        cacheMode: 'keyword',
        computeResults: async resultLimit => keywordSearchOnly(
            query,
            CHENGYU_DATABASE,
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
    if (!CHENGYU_EMBEDDINGS || !embeddingModelReady) {
        throw createHttpError(503, {
            error: 'Semantic search unavailable. Use hybrid search instead.',
            fallbackToHybrid: true
        });
    }

    return getCachedRankedResults({
        cacheKey: createSearchCacheKey('semantic', query),
        requestedWindow,
        bypassCache: bypassResultCache,
        cacheMode: 'semantic',
        computeResults: async resultLimit => semanticSearchOnly(
            query,
            CHENGYU_DATABASE,
            CHENGYU_EMBEDDINGS,
            loadFreshSearchConfig(),
            {
                resultLimit,
                generateQueryEmbedding: input => generateQueryEmbedding(input, {
                    bypassCache: bypassEmbeddingCache
                })
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
        cacheKey: createSearchCacheKey('hybrid', query),
        requestedWindow,
        bypassCache: bypassResultCache,
        cacheMode: 'hybrid',
        computeResults: async resultLimit => {
            logInfo(`✨ Hybrid search: "${query}" [${queryType}]`);

            return hybridSearch(
                query,
                CHENGYU_DATABASE,
                CHENGYU_EMBEDDINGS,
                {
                    ...loadFreshSearchConfig(),
                    ...loadHybridOverrides()
                },
                {
                    resultLimit,
                    generateQueryEmbedding: input => generateQueryEmbedding(input, {
                        bypassCache: bypassEmbeddingCache
                    })
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
    const pagination = normalizePagination({ offset, limit });
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
    const pagination = normalizePagination({ offset, limit });
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
    const pagination = normalizePagination({ offset, limit });
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
    const pagination = normalizePagination({ offset, limit });
    const queryType = classifyQueryType(query);
    const preferredMode = getPreferredSearchMode(queryType, query);

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

function resetCaches() {
    embeddingCache.cache.clear();
    searchResultCache.cache.clear();
}

async function initializeSearchState() {
    if (initialized) return;
    if (initializationPromise) {
        await initializationPromise;
        return;
    }

    initializationPromise = (async () => {
        logInfo('\n🚀 Chengyu Search API Server\n');

        const dbLoaded = await loadChengyuDatabase();
        if (!dbLoaded) {
            throw new Error('Failed to load chengyu database');
        }

        const embeddingsLoaded = await loadEmbeddings();
        if (embeddingsLoaded) {
            await initializeEmbeddingModel();
            const configuredModel = getEmbeddingModelId();
            if (embeddingMetadata.model && embeddingMetadata.model !== configuredModel) {
                console.error(`⚠️  Embedding file model (${embeddingMetadata.model}) does not match query model (${configuredModel})`);
            }
        }

        resetCaches();
        initialized = true;
    })();

    try {
        await initializationPromise;
    } catch (error) {
        initializationPromise = null;
        throw error;
    }
}

// API Routes
app.get('/api/health', (req, res) => {
    const startTimeMs = Date.now();
    const payload = {
        status: 'ok',
        database: CHENGYU_DATABASE.length > 0,
        embeddings: CHENGYU_EMBEDDINGS !== null,
        embeddingModel: embeddingModelReady,
        embeddingFile: embeddingMetadata.file,
        embeddingDimensions: embeddingMetadata.dimensions,
        embeddingTemplate: embeddingMetadata.template,
        configuredEmbeddingModel: getEmbeddingModelId(),
        loadedEmbeddingModel: embeddingMetadata.model,
        searchConfigOverride: Boolean(loadSearchConfigOverride()),
        autoRouting: true,
        defaultRoute: 'auto',
        chengyuCount: CHENGYU_DATABASE.length
    };
    res.json(payload);
    recordRequestMetrics({
        endpoint: 'health',
        statusCode: 200,
        durationMs: Date.now() - startTimeMs
    });
});

app.get('/api/metrics', (req, res) => {
    res.json({
        status: 'ok',
        metrics: getRuntimeMetricsSnapshot()
    });
});

app.post('/api/search', async (req, res) => {
    const startTimeMs = Date.now();
    const { query, limit, offset } = req.body;
    const bypassResultCache = req.get('x-benchmark-bypass-cache') === '1';
    const bypassEmbeddingCache = req.get('x-benchmark-bypass-embedding-cache') === '1';

    if (!query || typeof query !== 'string') {
        recordFailedRequest('search_auto', startTimeMs, createHttpError(400, { error: 'Query is required' }));
        return res.status(400).json({ error: 'Query is required' });
    }

    if (!CHENGYU_DATABASE || CHENGYU_DATABASE.length === 0) {
        recordFailedRequest('search_auto', startTimeMs, createHttpError(503, { error: 'Search engine not initialized' }));
        return res.status(503).json({ error: 'Search engine not initialized' });
    }

    try {
        const response = await executeAutoSearch(query, {
            offset,
            limit,
            bypassResultCache,
            bypassEmbeddingCache
        });
        res.json(response);
        recordSuccessfulRequest('search_auto', startTimeMs, response);
    } catch (error) {
        if (shouldLogServerError(error)) {
            console.error('Error in auto search:', error);
        }
        recordFailedRequest('search_auto', startTimeMs, error);
        res.status(error.statusCode || 500).json({
            error: error.error || 'Auto search failed',
            message: error.message,
            fallbackToHybrid: error.fallbackToHybrid || false
        });
    }
});

app.post('/api/search/keyword', async (req, res) => {
    const startTimeMs = Date.now();
    const { query, limit, offset } = req.body;
    const bypassResultCache = req.get('x-benchmark-bypass-cache') === '1';

    if (!query || typeof query !== 'string') {
        recordFailedRequest('search_keyword', startTimeMs, createHttpError(400, { error: 'Query is required' }));
        return res.status(400).json({ error: 'Query is required' });
    }

    if (!CHENGYU_DATABASE || CHENGYU_DATABASE.length === 0) {
        recordFailedRequest('search_keyword', startTimeMs, createHttpError(503, { error: 'Search engine not initialized' }));
        return res.status(503).json({ error: 'Search engine not initialized' });
    }

    logInfo(`🔍 Keyword search: "${query}"`);

    try {
        const response = await executeKeywordSearch(query, {
            offset,
            limit,
            bypassResultCache
        });
        res.json(response);
        recordSuccessfulRequest('search_keyword', startTimeMs, response);
    } catch (error) {
        if (shouldLogServerError(error)) {
            console.error('Error in keyword search:', error);
        }
        recordFailedRequest('search_keyword', startTimeMs, error);
        res.status(error.statusCode || 500).json({
            error: error.error || 'Keyword search failed',
            message: error.message
        });
    }
});

app.post('/api/search/semantic', async (req, res) => {
    const startTimeMs = Date.now();
    const { query, limit, offset } = req.body;
    const bypassResultCache = req.get('x-benchmark-bypass-cache') === '1';
    const bypassEmbeddingCache = req.get('x-benchmark-bypass-embedding-cache') === '1';

    if (!query || typeof query !== 'string') {
        recordFailedRequest('search_semantic', startTimeMs, createHttpError(400, { error: 'Query is required' }));
        return res.status(400).json({ error: 'Query is required' });
    }

    logInfo(`🧠 Semantic search: "${query}"`);

    try {
        const response = await executeSemanticSearch(query, {
            offset,
            limit,
            bypassResultCache,
            bypassEmbeddingCache
        });
        res.json(response);
        recordSuccessfulRequest('search_semantic', startTimeMs, response);
    } catch (error) {
        if (shouldLogServerError(error)) {
            console.error('Error in semantic search:', error);
        }
        recordFailedRequest('search_semantic', startTimeMs, error);
        res.status(error.statusCode || 500).json({
            error: error.error || 'Semantic search failed',
            message: error.message,
            fallbackToHybrid: error.fallbackToHybrid || false
        });
    }
});

app.post('/api/search/hybrid', async (req, res) => {
    const startTimeMs = Date.now();
    const { query, limit, offset } = req.body;
    const bypassResultCache = req.get('x-benchmark-bypass-cache') === '1';
    const bypassEmbeddingCache = req.get('x-benchmark-bypass-embedding-cache') === '1';

    if (!query || typeof query !== 'string') {
        recordFailedRequest('search_hybrid', startTimeMs, createHttpError(400, { error: 'Query is required' }));
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        const response = await executeHybridSearch(query, {
            offset,
            limit,
            bypassResultCache,
            bypassEmbeddingCache
        });
        res.json(response);
        recordSuccessfulRequest('search_hybrid', startTimeMs, response);
    } catch (error) {
        if (shouldLogServerError(error)) {
            console.error('Error in hybrid search:', error);
        }
        recordFailedRequest('search_hybrid', startTimeMs, error);
        res.status(error.statusCode || 500).json({
            error: error.error || 'Hybrid search failed',
            message: error.message
        });
    }
});

async function startServer({ port = DEFAULT_PORT } = {}) {
    await initializeSearchState();

    if (activeServer && activeServer.listening) {
        return activeServer;
    }

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            activeServer = server;
            const actualPort = server.address().port;
            logInfo(`\n✨ Server running on port ${actualPort}`);
            logInfo(`📍 http://localhost:${actualPort}`);
            logInfo('\n📊 Available endpoints:');
            logInfo('   GET  /api/health - Health check');
            logInfo('   GET  /api/metrics - Runtime metrics');
            logInfo('   POST /api/search - Auto-routed search (recommended)');
            logInfo('   POST /api/search/hybrid - Hybrid search');
            logInfo('   POST /api/search/keyword - Keyword search');
            logInfo('   POST /api/search/semantic - Semantic search');
            logInfo('\n💡 The UI now auto-routes English queries to semantic search and other queries to hybrid.\n');
            resolve(server);
        });

        server.on('error', error => {
            if (activeServer === server) {
                activeServer = null;
            }
            reject(error);
        });

        server.on('close', () => {
            if (activeServer === server) {
                activeServer = null;
            }
        });
    });
}

if (require.main === module) {
    startServer().catch(error => {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    });
}

module.exports = {
    app,
    startServer,
    initializeSearchState
};

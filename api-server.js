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
const { withStableChengyuIds } = require('./autoresearch/chengyu-identity.js');
const {
    buildEmbeddingCorpusHash,
    validateEmbeddingArtifact
} = require('./autoresearch/embedding-validation.js');
const {
    isBinaryEmbeddingPath,
    readBinaryEmbeddingArtifact
} = require('./autoresearch/embedding-binary.js');
const {
    getCedictVariantIndices,
    normalizeCedictPinyinKey
} = require('./autoresearch/cedict-variants.js');

const app = express();
const DEFAULT_PORT = process.env.PORT || 3000;
const QUIET_LOGS = process.env.QUIET_LOGS === '1';
const DEFAULT_EMBEDDINGS_FILE = 'embeddings-local.bin';
const DEFAULT_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_EMBEDDING_TEMPLATE = 'rich';
const DEFAULT_EMBEDDING_POOLING = 'mean';
const DEFAULT_EMBEDDING_NORMALIZE = true;
const EMBEDDING_PREPROCESSING_VERSION = 'v1';
const DEFAULT_EMBEDDING_CACHE_SIZE = 5000;
const DEFAULT_CROSS_ENCODER_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
const EMBEDDING_MODEL_DIMENSIONS = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/bge-small-en-v1.5': 384,
    'Xenova/bge-base-en-v1.5': 768,
    'Xenova/gte-small': 384,
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 384
};
const DEFAULT_MAX_QUERY_LENGTH = 500;
const DEFAULT_HSTS_MAX_AGE_SECONDS = 86400;
const SEARCH_RATE_LIMIT_PATHS = new Set([
    '/api/search',
    '/api/search/keyword',
    '/api/search/semantic',
    '/api/search/hybrid'
]);

function logInfo(...args) {
    if (!QUIET_LOGS) {
        console.log(...args);
    }
}

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

function isRuntimeMetricsExposed() {
    return !isProduction() || process.env.EXPOSE_RUNTIME_METRICS === '1';
}

function isVerboseHealthExposed() {
    return !isProduction() || process.env.EXPOSE_VERBOSE_HEALTH === '1';
}

function getConfiguredCorsAllowlist() {
    return new Set(
        String(process.env.CORS_ALLOWLIST || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
    );
}

function isAllowedCorsOrigin(origin) {
    if (!origin) return true;
    if (!isProduction()) return true;

    const allowlist = getConfiguredCorsAllowlist();
    return allowlist.size > 0 && allowlist.has(origin);
}

function getJsonBodyLimit() {
    return process.env.JSON_BODY_LIMIT || '16kb';
}

function getRateLimitWindowMs() {
    const configured = Number(process.env.RATE_LIMIT_WINDOW_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function getRateLimitMaxRequests() {
    const configured = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
    return Number.isFinite(configured) && configured > 0 ? configured : 120;
}

function isRateLimitingEnabled() {
    return isProduction() || process.env.ENABLE_RATE_LIMIT === '1';
}

function isBenchmarkBypassAllowed() {
    return !isProduction() || process.env.ENABLE_BENCHMARK_BYPASS === '1';
}

function getTrustProxySetting() {
    const configured = String(process.env.TRUST_PROXY || '').trim();
    if (!configured || configured === '0' || configured.toLowerCase() === 'false') return false;
    if (configured === '1' || configured.toLowerCase() === 'true') return 1;

    const hopCount = Number(configured);
    if (Number.isInteger(hopCount) && hopCount > 0) return hopCount;

    return configured;
}

const TRUST_PROXY_SETTING = getTrustProxySetting();

function isTrustedProxyEnabled() {
    return Boolean(TRUST_PROXY_SETTING);
}

function getRateLimitClientId(req) {
    if (isTrustedProxyEnabled()) {
        return req.ip || req.socket?.remoteAddress || 'unknown';
    }

    return req.socket?.remoteAddress || 'unknown';
}

function shouldBypassBenchmarkCache(req, headerName) {
    return isBenchmarkBypassAllowed() && req.get(headerName) === '1';
}

function getMaxQueryLength() {
    const configured = Number(process.env.MAX_QUERY_LENGTH);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_QUERY_LENGTH;
}

function getHstsMaxAgeSeconds() {
    const configured = Number(process.env.HSTS_MAX_AGE_SECONDS);
    return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_HSTS_MAX_AGE_SECONDS;
}

function buildHstsHeader() {
    if (!isProduction() || process.env.ENABLE_HSTS === '0') return null;

    const parts = [`max-age=${getHstsMaxAgeSeconds()}`];
    if (process.env.HSTS_INCLUDE_SUBDOMAINS === '1') {
        parts.push('includeSubDomains');
    }
    if (process.env.HSTS_PRELOAD === '1') {
        parts.push('preload');
    }
    return parts.join('; ');
}

function sanitizeEmbeddingFileLabel(filePath) {
    if (!filePath) return null;
    return path.basename(filePath);
}

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_SETTING);

function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    const hstsHeader = buildHstsHeader();
    if (hstsHeader) {
        res.setHeader('Strict-Transport-Security', hstsHeader);
    }

    next();
}

// Middleware
app.use(securityHeadersMiddleware);
app.use(cors({
    origin(origin, callback) {
        callback(null, isAllowedCorsOrigin(origin));
    },
    methods: ['GET', 'HEAD', 'POST'],
    optionsSuccessStatus: 204
}));
app.use(express.json({ limit: getJsonBodyLimit() }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data storage
let CHENGYU_DATABASE = [];
let CHENGYU_BY_ID = new Map();
let CHENGYU_EMBEDDINGS = null;
let embeddingMetadata = {
    file: null,
    model: null,
    template: null,
    dimensions: null,
    generatedAt: null,
    entryCount: null,
    validationDiagnostics: []
};
let embeddingModelReady = false;
let embeddingPipeline = null;
let crossEncoderReady = false;
let crossEncoderTokenizer = null;
let crossEncoderModel = null;
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

function getPositiveIntegerEnv(name, defaultValue) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

function normalizeEmbeddingCacheKey(query) {
    return String(query || '')
        .normalize('NFKC')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/u, '')
        .trim();
}

function createEmbeddingCacheKey(query) {
    return [
        getEmbeddingModelId(),
        getEmbeddingPooling(),
        getEmbeddingNormalize() ? 'normalize:true' : 'normalize:false',
        EMBEDDING_PREPROCESSING_VERSION,
        normalizeEmbeddingCacheKey(query)
    ].join('::');
}

const embeddingCache = new LRUCache(getPositiveIntegerEnv('EMBEDDING_CACHE_SIZE', DEFAULT_EMBEDDING_CACHE_SIZE));
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
const searchRateLimitState = new Map();

function getEndpointMetricKeyForPath(requestPath) {
    if (requestPath === '/api/search') return 'search_auto';
    if (requestPath === '/api/search/keyword') return 'search_keyword';
    if (requestPath === '/api/search/semantic') return 'search_semantic';
    if (requestPath === '/api/search/hybrid') return 'search_hybrid';
    if (requestPath === '/api/health') return 'health';
    if (requestPath === '/api/metrics') return 'metrics';
    return 'unknown';
}

function pruneRateLimitState(now = Date.now()) {
    for (const [key, value] of searchRateLimitState.entries()) {
        if (!value || value.resetAt <= now) {
            searchRateLimitState.delete(key);
        }
    }
}

function applySearchRateLimit(req, res, next) {
    if (!isRateLimitingEnabled() || !SEARCH_RATE_LIMIT_PATHS.has(req.path)) {
        return next();
    }

    const windowMs = getRateLimitWindowMs();
    const maxRequests = getRateLimitMaxRequests();
    const now = Date.now();
    const clientId = getRateLimitClientId(req);
    const key = `${req.path}::${clientId}`;
    const endpoint = getEndpointMetricKeyForPath(req.path);

    pruneRateLimitState(now);

    let entry = searchRateLimitState.get(key);
    if (!entry || entry.resetAt <= now) {
        entry = {
            count: 0,
            resetAt: now + windowMs
        };
    }

    if (entry.count >= maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.setHeader('RateLimit-Limit', String(maxRequests));
        res.setHeader('RateLimit-Remaining', '0');
        res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

        const error = createHttpError(429, { error: 'Too many requests. Please try again later.' });
        recordFailedRequest(endpoint, now, error);
        return res.status(429).json({ error: error.error });
    }

    entry.count += 1;
    searchRateLimitState.set(key, entry);

    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    next();
}

app.use(applySearchRateLimit);

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

function getEmbeddingTemplate() {
    return process.env.EMBEDDING_TEMPLATE || DEFAULT_EMBEDDING_TEMPLATE;
}

function getEmbeddingPooling() {
    return process.env.EMBEDDING_POOLING || DEFAULT_EMBEDDING_POOLING;
}

function getEmbeddingNormalize() {
    const configured = process.env.EMBEDDING_NORMALIZE;
    if (configured === undefined) return DEFAULT_EMBEDDING_NORMALIZE;
    return !['0', 'false', 'no'].includes(String(configured).trim().toLowerCase());
}

function getEmbeddingExpectedDimensions(modelId = getEmbeddingModelId()) {
    const configured = Number(process.env.EMBEDDING_DIMENSIONS);
    if (Number.isInteger(configured) && configured > 0) {
        return configured;
    }
    return EMBEDDING_MODEL_DIMENSIONS[modelId] || null;
}

function getCrossEncoderModelId() {
    return process.env.CROSS_ENCODER_MODEL_ID || DEFAULT_CROSS_ENCODER_MODEL_ID;
}

function hasCrossEncoderConfig(config) {
    if (!config || typeof config !== 'object') return false;
    if (Number(config.crossEncoderTopK || 0) > 0 && Number(config.crossEncoderBlendWeight || 0) > 0) return true;
    const typeOverrides = config.typeOverrides || {};
    return Object.values(typeOverrides).some(override => hasCrossEncoderConfig(override));
}

function isCrossEncoderConfigured() {
    if (process.env.CROSS_ENCODER_ENABLED === '1') return true;
    if (['0', 'false', 'no'].includes(String(process.env.CROSS_ENCODER_ENABLED || '').trim().toLowerCase())) return false;
    return hasCrossEncoderConfig(loadFreshSearchConfig()) || hasCrossEncoderConfig(loadHybridOverrides());
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
        CHENGYU_DATABASE = withStableChengyuIds(chengyuModule.map(enrichChengyuEntryWithVariants));
        CHENGYU_BY_ID = new Map(CHENGYU_DATABASE.map(entry => [entry.id, entry]));
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
        const embeddingsData = await fs.readFile(embeddingsFilePath);
        const parsed = isBinaryEmbeddingPath(embeddingsFilePath)
            ? readBinaryEmbeddingArtifact(embeddingsData)
            : JSON.parse(embeddingsData.toString('utf8'));
        const embeddingEntries = Array.isArray(parsed) ? parsed : parsed.embeddings;

        if (!Array.isArray(embeddingEntries)) {
            throw new Error('Embedding file must contain an array or an object with an embeddings array');
        }

        const expectedModel = getEmbeddingModelId();
        const expectedTemplate = getEmbeddingTemplate();
        const expectedDimensions = getEmbeddingExpectedDimensions(expectedModel);
        const expectedCorpusHash = buildEmbeddingCorpusHash(CHENGYU_DATABASE, expectedTemplate);
        const validation = validateEmbeddingArtifact(parsed, CHENGYU_DATABASE, {
            expectedModel,
            expectedPooling: getEmbeddingPooling(),
            expectedNormalize: getEmbeddingNormalize(),
            expectedTemplate,
            expectedDimensions,
            expectedCorpusHash,
            allowLegacyIds: false
        });
        embeddingMetadata = {
            file: embeddingsFilePath,
            model: parsed && !Array.isArray(parsed) ? (parsed.model || null) : null,
            template: parsed && !Array.isArray(parsed) ? (parsed.template || null) : null,
            pooling: parsed && !Array.isArray(parsed) ? (parsed.pooling || null) : null,
            normalize: parsed && !Array.isArray(parsed) ? (parsed.normalize ?? null) : null,
            dimensions: parsed && !Array.isArray(parsed)
                ? (parsed.dimensions || (embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null)
                : ((embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null),
            generatedAt: parsed && !Array.isArray(parsed) ? (parsed.generatedAt || null) : null,
            entryCount: parsed && !Array.isArray(parsed) ? (parsed.entryCount || embeddingEntries.length) : embeddingEntries.length,
            corpusHash: parsed && !Array.isArray(parsed) ? (parsed.corpusHash || null) : null,
            validationDiagnostics: validation.diagnostics
        };

        if (!validation.ok) {
            console.error('❌ Embedding artifact validation failed:');
            validation.diagnostics.slice(0, 10).forEach(diagnostic => {
                console.error(`   - ${diagnostic}`);
            });
            if (validation.diagnostics.length > 10) {
                console.error(`   - ... ${validation.diagnostics.length - 10} additional validation errors`);
            }
            console.error('   Hybrid search will fall back to keyword/token scoring only');
            CHENGYU_EMBEDDINGS = null;
            return false;
        }

        CHENGYU_EMBEDDINGS = validation.embeddingsById;
        logInfo(`✓ Loaded ${CHENGYU_EMBEDDINGS.size} embeddings (${Math.round(embeddingsData.length / 1024 / 1024)}MB)`);
        return true;
    } catch (error) {
        console.error(`⚠️  Embeddings not found at ${embeddingsFilePath} - semantic endpoint will be disabled`);
        console.error('   Hybrid search will continue without embedding reranking');
        CHENGYU_EMBEDDINGS = null;
        embeddingMetadata = {
            file: embeddingsFilePath,
            model: null,
            template: null,
            pooling: null,
            normalize: null,
            dimensions: null,
            generatedAt: null,
            entryCount: null,
            corpusHash: null,
            validationDiagnostics: [error.message]
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

    const normalizedQuery = normalizeEmbeddingCacheKey(query);
    const cacheKey = createEmbeddingCacheKey(normalizedQuery);

    if (!bypassCache) {
        const cached = embeddingCache.get(cacheKey);
        if (cached) {
            recordCacheOutcome('embedding', 'hit');
            return cached;
        }
        recordCacheOutcome('embedding', 'miss');
    } else {
        recordCacheOutcome('embedding', 'bypass');
    }

    const output = await embeddingPipeline(normalizedQuery, {
        pooling: getEmbeddingPooling(),
        normalize: getEmbeddingNormalize()
    });
    const embedding = Array.from(output.data);

    if (!bypassCache) {
        embeddingCache.set(cacheKey, embedding);
    }

    return embedding;
}

async function initializeCrossEncoderReranker() {
    if (!isCrossEncoderConfigured()) {
        crossEncoderReady = false;
        crossEncoderTokenizer = null;
        crossEncoderModel = null;
        return false;
    }

    const modelId = getCrossEncoderModelId();
    logInfo(`🔁 Loading cross-encoder reranker (${modelId})...`);
    try {
        const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
        crossEncoderTokenizer = await AutoTokenizer.from_pretrained(modelId);
        crossEncoderModel = await AutoModelForSequenceClassification.from_pretrained(modelId);
        crossEncoderReady = true;
        logInfo('✓ Cross-encoder reranker ready');
        return true;
    } catch (error) {
        console.error('⚠️  Error loading cross-encoder reranker:', error.message || error);
        console.error('   Continuing without cross-encoder reranking');
        crossEncoderReady = false;
        crossEncoderTokenizer = null;
        crossEncoderModel = null;
        return false;
    }
}

function buildCrossEncoderDocumentText(entry = {}) {
    return [
        entry.meaning ? `Meaning: ${entry.meaning}` : '',
        entry.literal ? `Literal: ${entry.literal}` : '',
        entry.example ? `Example: ${entry.example}` : '',
        Array.isArray(entry.tags) && entry.tags.length ? `Topics: ${entry.tags.join(', ')}` : ''
    ].filter(Boolean).join('. ');
}

async function scoreCrossEncoderCandidates(query, candidates) {
    if (!crossEncoderReady || !crossEncoderTokenizer || !crossEncoderModel) {
        throw new Error('Cross-encoder reranker not initialized');
    }

    const queryTexts = candidates.map(() => query);
    const documentTexts = candidates.map(candidate => buildCrossEncoderDocumentText(candidate.item || {}));
    const features = crossEncoderTokenizer(queryTexts, {
        text_pair: documentTexts,
        padding: true,
        truncation: true
    });
    const output = await crossEncoderModel(features);
    const logits = output.logits;
    const values = Array.from(logits.data || []);
    const dims = Array.isArray(logits.dims) ? logits.dims : [];
    const labelCount = dims.length >= 2 ? dims[1] : 1;

    if (labelCount <= 1) return values;

    const scores = [];
    for (let i = 0; i < candidates.length; i++) {
        const offset = i * labelCount;
        scores.push(values[offset + labelCount - 1] - values[offset]);
    }
    return scores;
}

function getCrossEncoderSearchOption() {
    return crossEncoderReady ? { scoreCrossEncoder: scoreCrossEncoderCandidates } : {};
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
        .map(({ item, id, chengyu, score }) => {
            const entry = item || CHENGYU_BY_ID.get(id);
            if (!entry) return null;
            return {
                id: entry.id,
                chengyu: entry.chengyu,
                simplified: entry.simplified || entry.chengyu,
                traditional: entry.traditional || entry.chengyu,
                pinyin: entry.pinyin,
                literal: entry.literal,
                meaning: entry.meaning,
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

function getSearchQueryValidationError(query) {
    if (!query || typeof query !== 'string') {
        return createHttpError(400, { error: 'Query is required' });
    }

    const maxQueryLength = getMaxQueryLength();
    if (query.length > maxQueryLength) {
        return createHttpError(400, { error: `query cannot exceed ${maxQueryLength} characters` });
    }

    return null;
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

const AUTO_ROUTE_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
    'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
    'with', 'like', 'up', 'out', 'off', 'over', 'under', 'about', 'through',
    'what', 'you', 'your'
]);

function getAutoRouteTokenSignals(normalizedQuery, normalizedTokens) {
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

    if (!normalizedQuery || CHENGYU_DATABASE.length === 0) {
        return signals;
    }

    const contentTokenSet = new Set(contentTokens);

    CHENGYU_DATABASE.forEach(entry => {
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

function getPreferredSearchMode(queryType, query) {
    const normalizedQuery = normalizeAutoRouteQuery(query);
    const normalizedTokens = normalizedQuery ? normalizedQuery.split(' ') : [];
    const signals = getAutoRouteTokenSignals(normalizedQuery, normalizedTokens);

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
    searchRateLimitState.clear();
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
        }
        await initializeCrossEncoderReranker();

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

function buildHealthPayload() {
    const basePayload = {
        status: 'ok',
        database: CHENGYU_DATABASE.length > 0,
        embeddings: CHENGYU_EMBEDDINGS !== null,
        embeddingModel: embeddingModelReady,
        crossEncoderReranker: crossEncoderReady,
        autoRouting: true,
        defaultRoute: 'auto',
        chengyuCount: CHENGYU_DATABASE.length
    };

    if (!isVerboseHealthExposed()) {
        return basePayload;
    }

    return {
        ...basePayload,
        embeddingFile: sanitizeEmbeddingFileLabel(embeddingMetadata.file),
        embeddingDimensions: embeddingMetadata.dimensions,
        embeddingTemplate: embeddingMetadata.template,
        embeddingPooling: embeddingMetadata.pooling,
        embeddingNormalize: embeddingMetadata.normalize,
        embeddingCorpusHash: embeddingMetadata.corpusHash,
        configuredEmbeddingModel: getEmbeddingModelId(),
        configuredEmbeddingTemplate: getEmbeddingTemplate(),
        configuredEmbeddingPooling: getEmbeddingPooling(),
        configuredEmbeddingNormalize: getEmbeddingNormalize(),
        loadedEmbeddingModel: embeddingMetadata.model,
        crossEncoderModel: crossEncoderReady ? getCrossEncoderModelId() : null,
        embeddingValidationDiagnostics: (embeddingMetadata.validationDiagnostics || []).slice(0, 10),
        searchConfigOverride: Boolean(loadSearchConfigOverride())
    };
}

// API Routes
app.get('/api/health', (req, res) => {
    const startTimeMs = Date.now();
    const payload = buildHealthPayload();
    res.json(payload);
    recordRequestMetrics({
        endpoint: 'health',
        statusCode: 200,
        durationMs: Date.now() - startTimeMs
    });
});

app.get('/api/metrics', (req, res) => {
    const startTimeMs = Date.now();

    if (!isRuntimeMetricsExposed()) {
        const error = createHttpError(404, { error: 'Not found' });
        recordFailedRequest('metrics', startTimeMs, error);
        return res.status(404).json({ error: error.error });
    }

    res.json({
        status: 'ok',
        metrics: getRuntimeMetricsSnapshot()
    });
    recordRequestMetrics({
        endpoint: 'metrics',
        statusCode: 200,
        durationMs: Date.now() - startTimeMs
    });
});

app.post('/api/search', async (req, res) => {
    const startTimeMs = Date.now();
    const { query, limit, offset } = req.body;
    const bypassResultCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-cache');
    const bypassEmbeddingCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-embedding-cache');

    const validationError = getSearchQueryValidationError(query);
    if (validationError) {
        recordFailedRequest('search_auto', startTimeMs, validationError);
        return res.status(validationError.statusCode).json({ error: validationError.error });
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
    const bypassResultCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-cache');

    const validationError = getSearchQueryValidationError(query);
    if (validationError) {
        recordFailedRequest('search_keyword', startTimeMs, validationError);
        return res.status(validationError.statusCode).json({ error: validationError.error });
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
    const bypassResultCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-cache');
    const bypassEmbeddingCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-embedding-cache');

    const validationError = getSearchQueryValidationError(query);
    if (validationError) {
        recordFailedRequest('search_semantic', startTimeMs, validationError);
        return res.status(validationError.statusCode).json({ error: validationError.error });
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
    const bypassResultCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-cache');
    const bypassEmbeddingCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-embedding-cache');

    const validationError = getSearchQueryValidationError(query);
    if (validationError) {
        recordFailedRequest('search_hybrid', startTimeMs, validationError);
        return res.status(validationError.statusCode).json({ error: validationError.error });
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
            logInfo('   GET  /api/metrics - Runtime metrics (dev / opt-in in production)');
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
    initializeSearchState,
    normalizeEmbeddingCacheKey,
    createEmbeddingCacheKey
};

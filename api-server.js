// Chengyu Search API Server - backend-powered search
const path = require('path');
const { createSearchExecutionService } = require('./src/search/search-service.js');
const searchConfig = require('./src/search/search-config.js');
const {
    loadSearchConfigOverride: loadSearchConfigOverrideFromEnv,
    loadFreshSearchConfig: loadFreshSearchConfigFromDisk,
    loadHybridOverrides: loadHybridOverridesFromDisk
} = require('./src/search/config-loader.js');
const { loadChengyuCorpus } = require('./src/data/corpus-loader.js');
const { loadEmbeddingArtifact } = require('./src/embeddings/artifact-loader.js');
const { LRUCache, TTLCache } = require('./src/shared/cache.js');
const {
    normalizeEmbeddingCacheKey,
    createEmbeddingCacheKey: buildEmbeddingCacheKey
} = require('./src/embeddings/embedding-cache.js');
const {
    initializeEmbeddingPipeline,
    generateQueryEmbedding: generateQueryEmbeddingWithProvider
} = require('./src/embeddings/transformers-provider.js');
const { createRuntimeMetricsRecorder } = require('./src/server/runtime-metrics.js');
const { createApp: createExpressApp } = require('./src/server/app.js');
const {
    DEFAULT_PORT,
    DEFAULT_EMBEDDINGS_FILE,
    DEFAULT_EMBEDDING_MODEL_ID,
    DEFAULT_EMBEDDING_TEMPLATE,
    DEFAULT_EMBEDDING_POOLING,
    DEFAULT_EMBEDDING_NORMALIZE,
    EMBEDDING_PREPROCESSING_VERSION,
    DEFAULT_EMBEDDING_CACHE_SIZE,
    DEFAULT_CROSS_ENCODER_MODEL_ID,
    EMBEDDING_MODEL_DIMENSIONS,
    logInfo,
    isProduction,
    isRuntimeMetricsExposed,
    isVerboseHealthExposed,
    isAllowedCorsOrigin,
    getJsonBodyLimit,
    getRateLimitWindowMs,
    getRateLimitMaxRequests,
    isRateLimitingEnabled,
    isBenchmarkBypassAllowed,
    getTrustProxySetting,
    getMaxQueryLength,
    buildHstsHeader,
    getPositiveIntegerEnv
} = require('./src/server/config.js');
const { createSearchRateLimitMiddleware } = require('./src/server/middleware.js');
const { createPaginatedSearchResponse: buildPaginatedSearchResponse } = require('./src/server/search-response.js');
const { createSearchRouteHandler } = require('./src/server/search-routes.js');
const { buildHealthPayload: buildHealthPayloadFromState } = require('./src/server/health-routes.js');
const {
    initializeCrossEncoderReranker: initializeCrossEncoderRerankerProvider,
    scoreCrossEncoderCandidates: scoreCrossEncoderCandidatesWithProvider
} = require('./src/search/cross-encoder-reranker.js');


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

function sanitizeEmbeddingFileLabel(filePath) {
    if (!filePath) return null;
    return path.basename(filePath);
}

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

function createEmbeddingCacheKey(query) {
    return buildEmbeddingCacheKey(query, {
        modelId: getEmbeddingModelId(),
        pooling: getEmbeddingPooling(),
        normalize: getEmbeddingNormalize(),
        preprocessingVersion: EMBEDDING_PREPROCESSING_VERSION
    });
}

const embeddingCache = new LRUCache(getPositiveIntegerEnv('EMBEDDING_CACHE_SIZE', DEFAULT_EMBEDDING_CACHE_SIZE));
const searchResultCache = new TTLCache(75, 300000);
const {
    recordCacheOutcome,
    recordRequestMetrics,
    getRuntimeMetricsSnapshot
} = createRuntimeMetricsRecorder();
const searchRateLimitState = new Map();

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

async function loadChengyuDatabase() {
    const result = await loadChengyuCorpus({
        logInfo,
        logError: console.error
    });
    CHENGYU_DATABASE = result.database;
    CHENGYU_BY_ID = result.byId;
    return result.ok;
}

async function loadEmbeddings() {
    const embeddingsFilePath = getEmbeddingsFilePath();
    const expectedModel = getEmbeddingModelId();
    const result = await loadEmbeddingArtifact({
        filePath: embeddingsFilePath,
        database: CHENGYU_DATABASE,
        expectedModel,
        expectedTemplate: getEmbeddingTemplate(),
        expectedDimensions: getEmbeddingExpectedDimensions(expectedModel),
        expectedPooling: getEmbeddingPooling(),
        expectedNormalize: getEmbeddingNormalize(),
        logInfo,
        logError: console.error,
        displayPath: path.relative(__dirname, embeddingsFilePath) || path.basename(embeddingsFilePath)
    });

    CHENGYU_EMBEDDINGS = result.embeddingsById;
    embeddingMetadata = result.metadata;
    return result.ok;
}

async function initializeEmbeddingModel() {
    const result = await initializeEmbeddingPipeline({
        modelId: getEmbeddingModelId(),
        logInfo,
        logError: console.error
    });
    embeddingPipeline = result.pipeline;
    embeddingModelReady = result.ok;
    return result.ok;
}

async function generateQueryEmbedding(query, { bypassCache = false } = {}) {
    return generateQueryEmbeddingWithProvider({
        query,
        embeddingPipeline,
        pooling: getEmbeddingPooling(),
        normalize: getEmbeddingNormalize(),
        cache: embeddingCache,
        createCacheKey: createEmbeddingCacheKey,
        normalizeCacheKey: normalizeEmbeddingCacheKey,
        recordCacheOutcome,
        bypassCache
    });
}

async function initializeCrossEncoderReranker() {
    const result = await initializeCrossEncoderRerankerProvider({
        enabled: isCrossEncoderConfigured(),
        modelId: getCrossEncoderModelId(),
        logInfo,
        logError: console.error
    });
    crossEncoderReady = result.ok;
    crossEncoderTokenizer = result.tokenizer;
    crossEncoderModel = result.model;
    return result.ok;
}

async function scoreCrossEncoderCandidates(query, candidates) {
    return scoreCrossEncoderCandidatesWithProvider({
        query,
        candidates,
        tokenizer: crossEncoderTokenizer,
        model: crossEncoderModel
    });
}

function getCrossEncoderSearchOption() {
    return crossEncoderReady ? { scoreCrossEncoder: scoreCrossEncoderCandidates } : {};
}

function loadSearchConfigOverride() {
    return loadSearchConfigOverrideFromEnv({
        repoRoot: __dirname,
        logError: console.error
    });
}

function loadFreshSearchConfig() {
    return loadFreshSearchConfigFromDisk({
        configPath: path.join(__dirname, 'src', 'search', 'search-config.js'),
        fallbackConfig: searchConfig,
        repoRoot: __dirname,
        logError: console.error
    });
}

function loadHybridOverrides() {
    return loadHybridOverridesFromDisk({
        hybridConfigPath: path.join(__dirname, 'src', 'search', 'hybrid-config.json')
    });
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

const searchExecutionService = createSearchExecutionService({
    getDatabase: () => CHENGYU_DATABASE,
    getEmbeddings: () => CHENGYU_EMBEDDINGS,
    isEmbeddingModelReady: () => embeddingModelReady,
    rankedResultCache: searchResultCache,
    recordCacheOutcome,
    createHttpError,
    createPaginatedSearchResponse: options => buildPaginatedSearchResponse({
        ...options,
        byId: CHENGYU_BY_ID
    }),
    loadFreshSearchConfig,
    loadHybridOverrides,
    generateQueryEmbedding,
    getCrossEncoderSearchOption,
    logInfo
});

const {
    executeKeywordSearch,
    executeSemanticSearch,
    executeHybridSearch,
    executeAutoSearch
} = searchExecutionService;

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
    return buildHealthPayloadFromState({
        databaseCount: CHENGYU_DATABASE.length,
        embeddingsLoaded: CHENGYU_EMBEDDINGS !== null,
        embeddingModelReady,
        crossEncoderReady,
        verbose: isVerboseHealthExposed(),
        embeddingMetadata,
        sanitizeEmbeddingFileLabel,
        getEmbeddingModelId,
        getEmbeddingTemplate,
        getEmbeddingPooling,
        getEmbeddingNormalize,
        getCrossEncoderModelId,
        hasSearchConfigOverride: () => Boolean(loadSearchConfigOverride())
    });
}

// API Routes
function createApp() {
    const commonSearchRouteOptions = {
        getValidationError: getSearchQueryValidationError,
        shouldBypassBenchmarkCache,
        recordFailedRequest,
        recordSuccessfulRequest,
        createHttpError,
        shouldLogServerError,
        logInfo
    };

    return createExpressApp({
        trustProxySetting: TRUST_PROXY_SETTING,
        buildHstsHeader,
        isAllowedCorsOrigin,
        getJsonBodyLimit,
        publicDir: path.join(__dirname, 'public'),
        rateLimitMiddleware: createSearchRateLimitMiddleware({
            isRateLimitingEnabled,
            getRateLimitWindowMs,
            getRateLimitMaxRequests,
            getRateLimitClientId,
            recordFailedRequest,
            createHttpError,
            searchRateLimitState
        }),
        healthRoutes: {
            buildHealthPayload,
            isRuntimeMetricsExposed,
            getRuntimeMetricsSnapshot,
            recordRequestMetrics,
            recordFailedRequest,
            createHttpError
        },
        searchRoutes: {
            auto: createSearchRouteHandler({
                ...commonSearchRouteOptions,
                endpoint: 'search_auto',
                label: 'auto',
                defaultError: 'Auto search failed',
                executeSearch: executeAutoSearch,
                requireDatabase: true,
                hasDatabase: () => Boolean(CHENGYU_DATABASE && CHENGYU_DATABASE.length > 0),
                supportsEmbeddingBypass: true,
                includeFallbackToHybrid: true
            }),
            keyword: createSearchRouteHandler({
                ...commonSearchRouteOptions,
                endpoint: 'search_keyword',
                label: 'keyword',
                defaultError: 'Keyword search failed',
                executeSearch: executeKeywordSearch,
                requireDatabase: true,
                hasDatabase: () => Boolean(CHENGYU_DATABASE && CHENGYU_DATABASE.length > 0),
                logMessage: query => `🔍 Keyword search: "${query}"`
            }),
            semantic: createSearchRouteHandler({
                ...commonSearchRouteOptions,
                endpoint: 'search_semantic',
                label: 'semantic',
                defaultError: 'Semantic search failed',
                executeSearch: executeSemanticSearch,
                supportsEmbeddingBypass: true,
                includeFallbackToHybrid: true,
                logMessage: query => `🧠 Semantic search: "${query}"`
            }),
            hybrid: createSearchRouteHandler({
                ...commonSearchRouteOptions,
                endpoint: 'search_hybrid',
                label: 'hybrid',
                defaultError: 'Hybrid search failed',
                executeSearch: executeHybridSearch,
                supportsEmbeddingBypass: true
            })
        }
    });
}

const app = createApp();

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
    createApp,
    startServer,
    initializeSearchState,
    normalizeEmbeddingCacheKey,
    createEmbeddingCacheKey
};

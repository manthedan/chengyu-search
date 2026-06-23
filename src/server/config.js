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

function getPositiveIntegerEnv(name, defaultValue) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

module.exports = {
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
};

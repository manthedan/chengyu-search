/** @ts-check */

/**
 * @typedef {Record<string, number>} CounterBucket
 * @typedef {{ total: number, count: number, min: number | null, max: number }} LatencyBucket
 * @typedef {{ hits: number, misses: number, bypasses: number }} CacheOutcomeBucket
 * @typedef {CacheOutcomeBucket & { by_mode?: Record<string, CacheOutcomeBucket> }} CacheBucket
 * @typedef {object} RuntimeMetrics
 * @property {string} startedAt
 * @property {{ total: number, by_endpoint: CounterBucket, by_status: CounterBucket, by_mode: CounterBucket, by_query_type: CounterBucket, by_offset: CounterBucket, empty_results: number, load_more_requests: number }} requests
 * @property {{ embedding: CacheBucket, ranked_results: CacheBucket }} caches
 * @property {LatencyBucket & { by_endpoint: Record<string, LatencyBucket>, by_mode: Record<string, LatencyBucket> }} latency_ms
 * @typedef {object} SearchResponseMetrics
 * @property {string} [mode]
 * @property {string} [queryType]
 * @property {number} [offset]
 * @property {number} [count]
 * @typedef {object} RequestMetricDetails
 * @property {string} endpoint
 * @property {number} statusCode
 * @property {number} durationMs
 * @property {SearchResponseMetrics | null} [response]
 * @typedef {'embedding' | 'ranked_results'} CacheType
 * @typedef {'hit' | 'miss' | 'bypass'} CacheOutcome
 */

/**
 * @returns {RuntimeMetrics}
 */
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

/**
 * @param {CounterBucket} bucket
 * @param {string} key
 * @param {number} [amount]
 * @returns {void}
 */
function incrementCounter(bucket, key, amount = 1) {
    bucket[key] = (bucket[key] || 0) + amount;
}

/**
 * @param {LatencyBucket} bucket
 * @param {number} durationMs
 * @returns {void}
 */
function updateLatencyBucket(bucket, durationMs) {
    bucket.total = (bucket.total || 0) + durationMs;
    bucket.count = (bucket.count || 0) + 1;
    bucket.min = bucket.min == null ? durationMs : Math.min(bucket.min, durationMs);
    bucket.max = Math.max(bucket.max || 0, durationMs);
}

/**
 * @param {Record<string, LatencyBucket>} collection
 * @param {string} key
 * @returns {LatencyBucket}
 */
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

/**
 * @param {LatencyBucket} bucket
 * @returns {{ count: number, avg: number, min: number, max: number, total: number }}
 */
function finalizeLatencyBucket(bucket) {
    return {
        count: bucket.count || 0,
        avg: (bucket.count || 0) > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
        min: bucket.min == null ? 0 : Number(bucket.min.toFixed(3)),
        max: Number((bucket.max || 0).toFixed(3)),
        total: Number((bucket.total || 0).toFixed(3))
    };
}

/**
 * @returns {{ recordCacheOutcome: (cacheType: CacheType, outcome: CacheOutcome, mode?: string | null) => void, recordRequestMetrics: (details: RequestMetricDetails) => void, getRuntimeMetricsSnapshot: () => object }}
 */
function createRuntimeMetricsRecorder() {
    const runtimeMetrics = createRuntimeMetrics();

    /**
     * @param {CacheType} cacheType
     * @param {CacheOutcome} outcome
     * @param {string | null} [mode]
     * @returns {void}
     */
    function recordCacheOutcome(cacheType, outcome, mode = null) {
        const cacheBucket = runtimeMetrics.caches[cacheType];
        if (!cacheBucket) return;

        const fieldName = /** @type {'hits' | 'misses' | 'bypasses'} */ ({
            hit: 'hits',
            miss: 'misses',
            bypass: 'bypasses'
        }[outcome]);

        if (!fieldName) return;

        cacheBucket[fieldName] = (cacheBucket[fieldName] || 0) + 1;

        if (mode && cacheBucket.by_mode) {
            if (!cacheBucket.by_mode[mode]) {
                cacheBucket.by_mode[mode] = { hits: 0, misses: 0, bypasses: 0 };
            }
            cacheBucket.by_mode[mode][fieldName] += 1;
        }
    }

    /**
     * @param {RequestMetricDetails} details
     * @returns {void}
     */
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

    /**
     * @returns {object}
     */
    function getRuntimeMetricsSnapshot() {
        /** @type {Record<string, ReturnType<typeof finalizeLatencyBucket>>} */
        const byEndpoint = {};
        Object.entries(runtimeMetrics.latency_ms.by_endpoint).forEach(([endpoint, bucket]) => {
            byEndpoint[endpoint] = finalizeLatencyBucket(bucket);
        });

        /** @type {Record<string, ReturnType<typeof finalizeLatencyBucket>>} */
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

    return {
        recordCacheOutcome,
        recordRequestMetrics,
        getRuntimeMetricsSnapshot
    };
}

module.exports = {
    createRuntimeMetrics,
    createRuntimeMetricsRecorder,
    finalizeLatencyBucket
};

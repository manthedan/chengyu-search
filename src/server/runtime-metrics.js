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

function finalizeLatencyBucket(bucket) {
    return {
        count: bucket.count || 0,
        avg: (bucket.count || 0) > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
        min: bucket.min == null ? 0 : Number(bucket.min.toFixed(3)),
        max: Number((bucket.max || 0).toFixed(3)),
        total: Number((bucket.total || 0).toFixed(3))
    };
}

function createRuntimeMetricsRecorder() {
    const runtimeMetrics = createRuntimeMetrics();

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

const SEARCH_RATE_LIMIT_PATHS = new Set([
    '/api/search',
    '/api/search/keyword',
    '/api/search/semantic',
    '/api/search/hybrid'
]);

function createSecurityHeadersMiddleware({ buildHstsHeader }) {
    return function securityHeadersMiddleware(req, res, next) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

        const hstsHeader = buildHstsHeader();
        if (hstsHeader) {
            res.setHeader('Strict-Transport-Security', hstsHeader);
        }

        next();
    };
}

function getEndpointMetricKeyForPath(requestPath) {
    if (requestPath === '/api/search') return 'search_auto';
    if (requestPath === '/api/search/keyword') return 'search_keyword';
    if (requestPath === '/api/search/semantic') return 'search_semantic';
    if (requestPath === '/api/search/hybrid') return 'search_hybrid';
    if (requestPath === '/api/health') return 'health';
    if (requestPath === '/api/metrics') return 'metrics';
    return 'unknown';
}

function pruneRateLimitState(searchRateLimitState, now = Date.now()) {
    for (const [key, value] of searchRateLimitState.entries()) {
        if (!value || value.resetAt <= now) {
            searchRateLimitState.delete(key);
        }
    }
}

function createSearchRateLimitMiddleware({
    isRateLimitingEnabled,
    getRateLimitWindowMs,
    getRateLimitMaxRequests,
    getRateLimitClientId,
    recordFailedRequest,
    createHttpError,
    searchRateLimitState = new Map()
}) {
    return function applySearchRateLimit(req, res, next) {
        if (!isRateLimitingEnabled() || !SEARCH_RATE_LIMIT_PATHS.has(req.path)) {
            return next();
        }

        const windowMs = getRateLimitWindowMs();
        const maxRequests = getRateLimitMaxRequests();
        const now = Date.now();
        const clientId = getRateLimitClientId(req);
        const key = `${req.path}::${clientId}`;
        const endpoint = getEndpointMetricKeyForPath(req.path);

        pruneRateLimitState(searchRateLimitState, now);

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
    };
}

module.exports = {
    SEARCH_RATE_LIMIT_PATHS,
    createSecurityHeadersMiddleware,
    createSearchRateLimitMiddleware,
    getEndpointMetricKeyForPath
};

function sendSearchError({ res, error, defaultError, includeFallbackToHybrid = false }) {
    const payload = {
        error: error.error || defaultError,
        message: error.message
    };
    if (includeFallbackToHybrid) {
        payload.fallbackToHybrid = error.fallbackToHybrid || false;
    }
    return res.status(error.statusCode || 500).json(payload);
}

function createSearchRouteHandler({
    endpoint,
    label,
    defaultError,
    executeSearch,
    getValidationError,
    requireDatabase = false,
    hasDatabase = () => true,
    shouldBypassBenchmarkCache,
    recordFailedRequest,
    recordSuccessfulRequest,
    createHttpError,
    shouldLogServerError,
    logInfo = () => {},
    logMessage = null,
    supportsEmbeddingBypass = false,
    includeFallbackToHybrid = false
}) {
    return async function searchRouteHandler(req, res) {
        const startTimeMs = Date.now();
        const { query, limit, offset } = req.body;
        const bypassResultCache = shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-cache');
        const bypassEmbeddingCache = supportsEmbeddingBypass
            ? shouldBypassBenchmarkCache(req, 'x-benchmark-bypass-embedding-cache')
            : false;

        const validationError = getValidationError(query);
        if (validationError) {
            recordFailedRequest(endpoint, startTimeMs, validationError);
            return res.status(validationError.statusCode).json({ error: validationError.error });
        }

        if (requireDatabase && !hasDatabase()) {
            const error = createHttpError(503, { error: 'Search engine not initialized' });
            recordFailedRequest(endpoint, startTimeMs, error);
            return res.status(503).json({ error: error.error });
        }

        if (logMessage) {
            logInfo(logMessage(query));
        }

        try {
            const response = await executeSearch(query, {
                offset,
                limit,
                bypassResultCache,
                bypassEmbeddingCache
            });
            res.json(response);
            recordSuccessfulRequest(endpoint, startTimeMs, response);
        } catch (error) {
            if (shouldLogServerError(error)) {
                console.error(`Error in ${label} search:`, error);
            }
            recordFailedRequest(endpoint, startTimeMs, error);
            return sendSearchError({
                res,
                error,
                defaultError,
                includeFallbackToHybrid
            });
        }
    };
}

module.exports = {
    createSearchRouteHandler,
    sendSearchError
};

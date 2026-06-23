function buildHealthPayload({
    databaseCount,
    embeddingsLoaded,
    embeddingModelReady,
    crossEncoderReady,
    verbose,
    embeddingMetadata = {},
    sanitizeEmbeddingFileLabel,
    getEmbeddingModelId,
    getEmbeddingTemplate,
    getEmbeddingPooling,
    getEmbeddingNormalize,
    getCrossEncoderModelId,
    hasSearchConfigOverride
}) {
    const basePayload = {
        status: 'ok',
        database: databaseCount > 0,
        embeddings: embeddingsLoaded,
        embeddingModel: embeddingModelReady,
        crossEncoderReranker: crossEncoderReady,
        autoRouting: true,
        defaultRoute: 'auto',
        chengyuCount: databaseCount
    };

    if (!verbose) {
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
        searchConfigOverride: Boolean(hasSearchConfigOverride())
    };
}

function installHealthRoutes(app, {
    buildHealthPayload,
    isRuntimeMetricsExposed,
    getRuntimeMetricsSnapshot,
    recordRequestMetrics,
    recordFailedRequest,
    createHttpError
}) {
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
}

module.exports = {
    buildHealthPayload,
    installHealthRoutes
};

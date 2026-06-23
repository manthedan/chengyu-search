const fs = require('fs').promises;
const path = require('path');
const {
    buildEmbeddingCorpusHash,
    validateEmbeddingArtifact
} = require('./embedding-validation.js');
const {
    isBinaryEmbeddingPath,
    readBinaryEmbeddingArtifact
} = require('./embedding-binary.js');

function buildEmbeddingMetadata({ filePath, parsed, embeddingEntries, validation }) {
    const hasMetadata = parsed && !Array.isArray(parsed);
    return {
        file: filePath,
        model: hasMetadata ? (parsed.model || null) : null,
        template: hasMetadata ? (parsed.template || null) : null,
        pooling: hasMetadata ? (parsed.pooling || null) : null,
        normalize: hasMetadata ? (parsed.normalize ?? null) : null,
        dimensions: hasMetadata
            ? (parsed.dimensions || (embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null)
            : ((embeddingEntries[0] && embeddingEntries[0].embedding && embeddingEntries[0].embedding.length) || null),
        generatedAt: hasMetadata ? (parsed.generatedAt || null) : null,
        entryCount: hasMetadata ? (parsed.entryCount || embeddingEntries.length) : embeddingEntries.length,
        corpusHash: hasMetadata ? (parsed.corpusHash || null) : null,
        validationDiagnostics: validation.diagnostics
    };
}

function buildMissingEmbeddingMetadata(filePath, error) {
    return {
        file: filePath,
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
}

async function loadEmbeddingArtifact({
    filePath,
    database,
    expectedModel,
    expectedTemplate,
    expectedDimensions,
    expectedPooling,
    expectedNormalize,
    logInfo = () => {},
    logError = console.error,
    displayPath = path.basename(filePath)
}) {
    logInfo(`🧠 Loading embeddings from ${displayPath}...`);
    try {
        const embeddingsData = await fs.readFile(filePath);
        const parsed = isBinaryEmbeddingPath(filePath)
            ? readBinaryEmbeddingArtifact(embeddingsData)
            : JSON.parse(embeddingsData.toString('utf8'));
        const embeddingEntries = Array.isArray(parsed) ? parsed : parsed.embeddings;

        if (!Array.isArray(embeddingEntries)) {
            throw new Error('Embedding file must contain an array or an object with an embeddings array');
        }

        const expectedCorpusHash = buildEmbeddingCorpusHash(database, expectedTemplate);
        const validation = validateEmbeddingArtifact(parsed, database, {
            expectedModel,
            expectedPooling,
            expectedNormalize,
            expectedTemplate,
            expectedDimensions,
            expectedCorpusHash,
            allowLegacyIds: false
        });
        const metadata = buildEmbeddingMetadata({
            filePath,
            parsed,
            embeddingEntries,
            validation
        });

        if (!validation.ok) {
            logError('❌ Embedding artifact validation failed:');
            validation.diagnostics.slice(0, 10).forEach(diagnostic => {
                logError(`   - ${diagnostic}`);
            });
            if (validation.diagnostics.length > 10) {
                logError(`   - ... ${validation.diagnostics.length - 10} additional validation errors`);
            }
            logError('   Hybrid search will fall back to keyword/token scoring only');
            return {
                ok: false,
                embeddingsById: null,
                metadata
            };
        }

        logInfo(`✓ Loaded ${validation.embeddingsById.size} embeddings (${Math.round(embeddingsData.length / 1024 / 1024)}MB)`);
        return {
            ok: true,
            embeddingsById: validation.embeddingsById,
            metadata
        };
    } catch (error) {
        logError(`⚠️  Embeddings not found at ${filePath} - semantic endpoint will be disabled`);
        logError('   Hybrid search will continue without embedding reranking');
        return {
            ok: false,
            embeddingsById: null,
            metadata: buildMissingEmbeddingMetadata(filePath, error)
        };
    }
}

module.exports = {
    loadEmbeddingArtifact,
    buildEmbeddingMetadata,
    buildMissingEmbeddingMetadata
};

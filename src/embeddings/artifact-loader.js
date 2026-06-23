/** @ts-check */

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

/**
 * @typedef {import('../search/types').ChengyuEntry} ChengyuEntry
 * @typedef {{ id?: string, chengyu?: string, embedding?: number[] | Float32Array }} EmbeddingArtifactRow
 * @typedef {{ model?: string, template?: string, pooling?: string, normalize?: boolean, dimensions?: number, generatedAt?: string, entryCount?: number, corpusHash?: string, embeddings?: EmbeddingArtifactRow[] }} EmbeddingArtifactObject
 * @typedef {{ ok: boolean, diagnostics: string[], embeddingsById: Map<string, number[] | Float32Array> }} EmbeddingValidationResult
 * @typedef {{ file: string, model: string | null, template: string | null, pooling: string | null, normalize: boolean | null, dimensions: number | null, generatedAt: string | null, entryCount: number | null, corpusHash: string | null, validationDiagnostics: string[] }} LoadedEmbeddingMetadata
 * @typedef {{ ok: true, embeddingsById: Map<string, number[] | Float32Array>, metadata: LoadedEmbeddingMetadata } | { ok: false, embeddingsById: null, metadata: LoadedEmbeddingMetadata }} LoadEmbeddingArtifactResult
 */

/**
 * @param {{ filePath: string, parsed: EmbeddingArtifactObject | EmbeddingArtifactRow[], embeddingEntries: EmbeddingArtifactRow[], validation: EmbeddingValidationResult }} options
 * @returns {LoadedEmbeddingMetadata}
 */
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

/**
 * @param {string} filePath
 * @param {unknown} error
 * @returns {LoadedEmbeddingMetadata}
 */
function buildMissingEmbeddingMetadata(filePath, error) {
    const message = error instanceof Error ? error.message : String(error);
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
        validationDiagnostics: [message]
    };
}

/**
 * @param {{ filePath: string, database: ChengyuEntry[], expectedModel?: string, expectedTemplate: string, expectedDimensions?: number, expectedPooling?: string, expectedNormalize?: boolean, logInfo?: (message: string) => void, logError?: (message: string) => void, displayPath?: string }} options
 * @returns {Promise<LoadEmbeddingArtifactResult>}
 */
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
        const parsed = /** @type {EmbeddingArtifactObject | EmbeddingArtifactRow[]} */ (isBinaryEmbeddingPath(filePath)
            ? readBinaryEmbeddingArtifact(embeddingsData)
            : JSON.parse(embeddingsData.toString('utf8')));
        const embeddingEntries = Array.isArray(parsed) ? parsed : parsed.embeddings;

        if (!Array.isArray(embeddingEntries)) {
            throw new Error('Embedding file must contain an array or an object with an embeddings array');
        }

        const expectedCorpusHash = buildEmbeddingCorpusHash(database, expectedTemplate);
        /** @type {import('./embedding-validation.js').ValidationOptions} */
        const validationOptions = {
            expectedTemplate,
            expectedCorpusHash,
            allowLegacyIds: false
        };
        if (expectedModel !== undefined) validationOptions.expectedModel = expectedModel;
        if (expectedPooling !== undefined) validationOptions.expectedPooling = expectedPooling;
        if (expectedNormalize !== undefined) validationOptions.expectedNormalize = expectedNormalize;
        if (expectedDimensions !== undefined) validationOptions.expectedDimensions = expectedDimensions;

        const validation = validateEmbeddingArtifact(parsed, database, validationOptions);
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

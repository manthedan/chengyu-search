async function initializeCrossEncoderReranker({
    enabled,
    modelId,
    logInfo = () => {},
    logError = console.error
}) {
    if (!enabled) {
        return {
            ok: false,
            tokenizer: null,
            model: null
        };
    }

    logInfo(`🔁 Loading cross-encoder reranker (${modelId})...`);
    try {
        const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
        const tokenizer = await AutoTokenizer.from_pretrained(modelId);
        const model = await AutoModelForSequenceClassification.from_pretrained(modelId);
        logInfo('✓ Cross-encoder reranker ready');
        return {
            ok: true,
            tokenizer,
            model
        };
    } catch (error) {
        logError('⚠️  Error loading cross-encoder reranker:', error.message || error);
        logError('   Continuing without cross-encoder reranking');
        return {
            ok: false,
            tokenizer: null,
            model: null
        };
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

async function scoreCrossEncoderCandidates({ query, candidates, tokenizer, model }) {
    if (!tokenizer || !model) {
        throw new Error('Cross-encoder reranker not initialized');
    }

    const queryTexts = candidates.map(() => query);
    const documentTexts = candidates.map(candidate => buildCrossEncoderDocumentText(candidate.item || {}));
    const features = tokenizer(queryTexts, {
        text_pair: documentTexts,
        padding: true,
        truncation: true
    });
    const output = await model(features);
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

module.exports = {
    initializeCrossEncoderReranker,
    buildCrossEncoderDocumentText,
    scoreCrossEncoderCandidates
};

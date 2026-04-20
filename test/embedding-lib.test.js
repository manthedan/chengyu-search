process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTemplateText,
    buildVariant,
    getVariantEnv,
    parseVariantSpec,
    resolveVariants
} = require('../benchmark/embedding-lib.js');

describe('embedding variant registry', () => {
    it('parses current and generated variant specs', () => {
        assert.deepEqual(parseVariantSpec('current'), { type: 'current' });
        assert.deepEqual(parseVariantSpec('minilm:english-dense'), {
            type: 'generated',
            modelKey: 'minilm',
            templateKey: 'english-dense'
        });
        assert.deepEqual(parseVariantSpec('bge-small__meaning-literal'), {
            type: 'generated',
            modelKey: 'bge-small',
            templateKey: 'meaning-literal'
        });
    });

    it('builds generated variants with stable ids and env', () => {
        const variant = buildVariant('bge-small:english-dense');
        assert.equal(variant.id, 'bge-small__english-dense');
        assert.equal(variant.modelId, 'Xenova/bge-small-en-v1.5');
        assert.match(variant.relativeFilePath, /embeddings\/variants\/bge-small__english-dense\.json$/);
        assert.deepEqual(getVariantEnv(variant), {
            EMBEDDINGS_FILE: variant.relativeFilePath,
            EMBEDDING_MODEL_ID: 'Xenova/bge-small-en-v1.5',
            QUIET_LOGS: '1'
        });
    });

    it('resolves quick preset and can exclude current baseline', () => {
        const withCurrent = resolveVariants({ preset: 'quick' });
        const withoutCurrent = resolveVariants({ preset: 'quick', includeCurrent: false });

        assert.equal(withCurrent[0].id, 'current');
        assert.ok(withoutCurrent.every(variant => variant.id !== 'current'));
        assert.ok(withoutCurrent.length < withCurrent.length);
    });

    it('builds template text with a safe fallback', () => {
        const text = buildTemplateText('meaning-literal', {
            chengyu: '画蛇添足',
            meaning: 'to ruin something by adding unnecessary detail',
            literal: 'draw snake add legs',
            tags: ['mistake']
        });
        assert.match(text, /draw snake add legs/);

        const fallback = buildTemplateText('meaning-only', {
            chengyu: '空空如也',
            meaning: '',
            literal: '',
            tags: []
        });
        assert.equal(fallback, '空空如也');
    });
});

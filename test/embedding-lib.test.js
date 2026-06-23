process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildStableChengyuId,
} = require('../src/data/chengyu-identity.js');
const {
    buildTemplateText,
    buildVariant,
    getVariantEnv,
    parseVariantSpec,
    resolveVariants
} = require('../benchmark/embedding-lib.js');
const {
    readBinaryEmbeddingArtifact,
    writeBinaryEmbeddingArtifact
} = require('../src/embeddings/embedding-binary.js');

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
        assert.deepEqual(parseVariantSpec('multilingual-minilm:rich'), {
            type: 'generated',
            modelKey: 'multilingual-minilm',
            templateKey: 'rich'
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
            EMBEDDING_POOLING: 'mean',
            EMBEDDING_NORMALIZE: 'true',
            EMBEDDING_TEMPLATE: 'english-dense',
            QUIET_LOGS: '1'
        });
    });

    it('resolves quick preset and can exclude current baseline', () => {
        const withCurrent = resolveVariants({ preset: 'quick' });
        const withoutCurrent = resolveVariants({ preset: 'quick', includeCurrent: false });

        assert.equal(withCurrent[0].id, 'current');
        assert.ok(withoutCurrent.every(variant => variant.id !== 'current'));
        assert.ok(withoutCurrent.length < withCurrent.length);

        const multilingual = resolveVariants({ preset: 'multilingual' });
        assert.ok(multilingual.some(variant => variant.modelId === 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'));

        const fieldSpecific = resolveVariants({ preset: 'field-specific' });
        assert.ok(fieldSpecific.some(variant => variant.templateKey === 'meaning-only'));
        assert.ok(fieldSpecific.some(variant => variant.templateKey === 'tags-meaning'));
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

    it('round-trips compact binary embedding artifacts', () => {
        const artifact = {
            version: 1,
            model: 'test-model',
            template: 'meaning-literal-tags',
            pooling: 'mean',
            normalize: true,
            dimensions: 2,
            corpusHash: 'hash',
            entryCount: 2,
            embeddings: [
                { id: 'one', chengyu: '一一一一', embedding: [1, 0.25] },
                { id: 'two', chengyu: '二二二二', embedding: [-0.5, 0] }
            ]
        };

        const buffer = writeBinaryEmbeddingArtifact(artifact);
        const parsed = readBinaryEmbeddingArtifact(buffer);

        assert.equal(parsed.model, artifact.model);
        assert.equal(parsed.template, artifact.template);
        assert.equal(parsed.dimensions, 2);
        assert.deepEqual(parsed.embeddings, artifact.embeddings);
    });

    it('builds deterministic stable IDs for embedding generation', () => {
        const entry = {
            chengyu: '难兄难弟',
            pinyin: 'nan4 xiong1 nan4 di4',
            literal: 'difficult brother difficult younger brother',
            meaning: 'fellow sufferers',
            example: '患难中的朋友常被称作难兄难弟。',
            tags: ['hardship'],
            formality: 'formal'
        };

        assert.equal(buildStableChengyuId(entry), buildStableChengyuId({ ...entry }));
        assert.match(buildStableChengyuId(entry), /^chengyu_[a-f0-9]{16}$/);
    });
});

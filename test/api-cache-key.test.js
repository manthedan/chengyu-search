process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createEmbeddingCacheKey,
    normalizeEmbeddingCacheKey
} = require('../api-server.js');

describe('embedding cache key normalization', () => {
    it('canonicalizes harmless query variants without dropping semantic words', () => {
        const variants = [
            'feeling hopeless',
            'Feeling hopeless',
            ' feeling   hopeless ',
            'feeling hopeless.',
            'Ｆｅｅｌｉｎｇ　ｈｏｐｅｌｅｓｓ！'
        ];

        assert.deepEqual(
            variants.map(normalizeEmbeddingCacheKey),
            Array(variants.length).fill('feeling hopeless')
        );
        assert.notEqual(normalizeEmbeddingCacheKey('not happy'), normalizeEmbeddingCacheKey('happy'));
    });

    it('includes embedding-space metadata in the cache key', () => {
        const first = createEmbeddingCacheKey(' Feeling   hopeless. ');
        const second = createEmbeddingCacheKey('feeling hopeless');

        assert.equal(first, second);
        assert.match(first, /^Xenova\/all-MiniLM-L6-v2::mean::normalize:true::v1::feeling hopeless$/);
    });
});

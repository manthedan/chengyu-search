process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_RERANKER_PROFILES,
    RERANKER_PROFILES,
    resolveRerankerProfiles
} = require('../benchmark/reranker-profiles.js');

describe('reranker profile registry', () => {
    it('resolves the default reranker profile list', () => {
        const profiles = resolveRerankerProfiles();
        assert.deepEqual(
            profiles.map(profile => profile.id),
            DEFAULT_RERANKER_PROFILES
        );
    });

    it('keeps the current profile override empty and exposes configured reranker weights', () => {
        const current = RERANKER_PROFILES.current;
        const medium = RERANKER_PROFILES['rerank-medium'];

        assert.equal(current.override, null);
        assert.equal(medium.override.rerankTopK, 24);
        assert.equal(medium.override.rerankBlendWeight, 0.25);
        assert.equal(medium.override.rerankMeaningPhraseWeight, 1.0);
    });

    it('throws on unknown reranker profiles', () => {
        assert.throws(() => resolveRerankerProfiles(['nope']), /Unknown reranker profile/);
    });
});

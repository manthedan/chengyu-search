process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_WEIGHT_PROFILES,
    resolveWeightProfiles,
    WEIGHT_PROFILES
} = require('../benchmark/weight-profiles.js');

describe('weight profile registry', () => {
    it('resolves the default profile list', () => {
        const profiles = resolveWeightProfiles();
        assert.deepEqual(
            profiles.map(profile => profile.id),
            DEFAULT_WEIGHT_PROFILES
        );
    });

    it('keeps current profile override empty and structured profiles scoped to typeOverrides', () => {
        const current = WEIGHT_PROFILES.current;
        const balanced = WEIGHT_PROFILES['balanced-plus'];

        assert.equal(current.override, null);
        assert.equal(balanced.override.typeOverrides.english_meaning.embeddingWeight, 0.75);
        assert.equal(balanced.override.typeOverrides.english_meaning.tokenWeight, 0.25);
        assert.equal(balanced.override.typeOverrides.literal.embeddingWeight, 0.35);
        assert.equal(balanced.override.typeOverrides.literal.tokenWeight, 0.65);
    });

    it('throws on unknown profiles', () => {
        assert.throws(() => resolveWeightProfiles(['nope']), /Unknown weight profile/);
    });
});

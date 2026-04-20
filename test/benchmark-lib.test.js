process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { splitHoldoutTestSet } = require('../benchmark/lib.js');

function makeCase(type, query) {
    return {
        query,
        type,
        expected: [
            {
                chengyu: `${type}:${query}`,
                relevance: 3
            }
        ]
    };
}

describe('benchmark holdout split', () => {
    it('creates a deterministic stratified split', () => {
        const testSet = [
            makeCase('english_meaning', 'alpha'),
            makeCase('english_meaning', 'beta'),
            makeCase('english_meaning', 'gamma'),
            makeCase('english_meaning', 'delta'),
            makeCase('pinyin', 'yi'),
            makeCase('pinyin', 'er'),
            makeCase('pinyin', 'san'),
            makeCase('pinyin', 'si'),
            { query: 'unlabeled', type: 'english_meaning', expected: [] }
        ];

        const first = splitHoldoutTestSet(testSet, { holdoutRatio: 0.25, seed: 'fixed-seed' });
        const second = splitHoldoutTestSet(testSet, { holdoutRatio: 0.25, seed: 'fixed-seed' });

        assert.deepEqual(
            first.holdoutSet.map(testCase => `${testCase.type}:${testCase.query}`),
            second.holdoutSet.map(testCase => `${testCase.type}:${testCase.query}`)
        );
        assert.deepEqual(first.summary.by_type, {
            english_meaning: { total: 4, development: 3, holdout: 1 },
            pinyin: { total: 4, development: 3, holdout: 1 }
        });
        assert.equal(first.summary.total_query_count, 8);
        assert.equal(first.summary.development_query_count, 6);
        assert.equal(first.summary.holdout_query_count, 2);
    });

    it('keeps singleton types out of the holdout when ratio is below 1', () => {
        const testSet = [
            makeCase('english_meaning', 'alpha'),
            makeCase('english_meaning', 'beta'),
            makeCase('english_meaning', 'gamma'),
            makeCase('english_meaning', 'delta'),
            makeCase('english_meaning', 'epsilon'),
            makeCase('english_meaning', 'zeta'),
            makeCase('singleton', 'only-one')
        ];

        const split = splitHoldoutTestSet(testSet, { holdoutRatio: 0.3, seed: 'fixed-seed' });

        assert.equal(split.summary.by_type.singleton.holdout, 0);
        assert.equal(split.summary.by_type.singleton.development, 1);
        assert.equal(split.summary.holdout_query_count, 2);
    });
});

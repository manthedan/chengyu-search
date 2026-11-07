// Fuzzy matcher parity: src/search/fuzzy-matcher.js must return exactly what
// fuse.js 7.1 returned for every call search-logic made on the query set:
// same items, same order, same scores, at every result limit callers use.
// Oracle: benchmark/fuzzy/oracle.json (node benchmark/fuzzy/build-oracle.js).
process.env.QUIET_LOGS = '1';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { createFuzzyMatcher } = require('../src/search/fuzzy-matcher');
const { PARITY_LIMITS, ORACLE_LIMIT, loadContext, loadOracle, corpusSha, checkParity } = require('../benchmark/fuzzy/lib');

describe('fuzzy matcher parity with fuse.js', () => {
    let oracle, lists;
    before(async () => {
        oracle = loadOracle();
        ({ lists } = await loadContext());
    });

    it('the oracle was recorded from fuse.js 7.1 for the current corpus', () => {
        assert.match(oracle.fuseVersion, /^7\.1\./);
        assert.strictEqual(oracle.corpusSha256, corpusSha(lists),
            'corpus changed: regenerate the oracle with node benchmark/fuzzy/build-oracle.js');
        assert.ok(oracle.calls.length > 300, 'oracle covers the query set');
        assert.deepStrictEqual(new Set(oracle.profiles.map(p => p.list)), new Set(['corpus', 'pinyin']));
    });

    it('returns identical items, order and scores for every recorded call', () => {
        const { mismatches, checks } = checkParity(createFuzzyMatcher, oracle, lists, { limits: PARITY_LIMITS });
        assert.deepStrictEqual(mismatches, [], `${mismatches.length} mismatching call(s) out of ${checks} checks`);
        assert.ok(PARITY_LIMITS.includes(ORACLE_LIMIT));
    });
});

// End-to-end ranking freeze: keywordSearchOnly() must return exactly what it
// returned with fuse.js 7.1 as the matcher, for every query in the query set
// at the default and maximum result windows. Oracle:
// benchmark/fuzzy/e2e-oracle.json (node benchmark/fuzzy/build-e2e-oracle.js).
process.env.QUIET_LOGS = '1';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { keywordSearchOnly } = require('../src/search/search-logic');
const { loadContext, corpusSha, sameScore } = require('../benchmark/fuzzy/lib');
const { E2E_ORACLE_PATH, snapshot } = require('../benchmark/fuzzy/build-e2e-oracle');

// Same rows, fields and order; numbers via sameScore (exact on the recording V8).
function sameResults(expected, actual, oracle) {
    return expected.length === actual.length && expected.every((row, i) => {
        const keys = Object.keys(row);
        return keys.join() === Object.keys(actual[i]).join() && keys.every(key => typeof row[key] === 'number'
            ? sameScore(row[key], actual[i][key], oracle)
            : Object.is(row[key], actual[i][key]));
    });
}

describe('keyword search rankings are frozen', () => {
    let oracle, database, config, lists;
    before(async () => {
        oracle = JSON.parse(fs.readFileSync(E2E_ORACLE_PATH, 'utf8'));
        ({ database, config, lists } = await loadContext());
    });

    it('the oracle matches the current corpus', () => {
        assert.strictEqual(oracle.corpusSha256, corpusSha(lists),
            'corpus changed: regenerate with node benchmark/fuzzy/build-e2e-oracle.js');
        assert.ok(oracle.cases.length > 600);
    });

    it('keywordSearchOnly returns identical results for every case', () => {
        const mismatches = [];
        for (const { q, resultLimit, r } of oracle.cases) {
            const actual = snapshot(keywordSearchOnly(q, database, config, resultLimit ? { resultLimit } : {}), database);
            if (!sameResults(r, actual, oracle)) mismatches.push({ q, resultLimit });
        }
        assert.deepStrictEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${oracle.cases.length} cases differ`);
    });
});

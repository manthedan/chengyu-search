#!/usr/bin/env node
'use strict';
// End-to-end oracle: what keywordSearchOnly() returns for every query in the
// query set (and its lexical variant) at the default and maximum result
// windows, computed with fuse.js 7.1 as the matcher. Lets later rounds change
// search-logic.js for speed while proving rankings stay frozen.
//
// The matcher is always fuse.js here (wrapped exactly like the original
// src/search/fuzzy-matcher.js), never the replacement under test.
//   node benchmark/fuzzy/build-e2e-oracle.js
const fs = require('node:fs');
const path = require('node:path');
const Fuse = require('fuse.js');
const { QUERIES_PATH, loadContext, corpusSha, recordingRuntime } = require('./lib');

const E2E_ORACLE_PATH = path.join(__dirname, 'e2e-oracle.json');
const RESULT_LIMITS = [undefined, 51];

function fuseMatcher(list, { keys, threshold, minMatchCharLength = 1, ignoreLocation = true }) {
    const fuse = new Fuse(list, { keys, threshold, minMatchCharLength, ignoreLocation, includeScore: true });
    return { search: (query, { limit } = {}) => fuse.search(query, limit ? { limit } : undefined).map(({ item, refIndex, score }) => ({ item, refIndex, score })) };
}

// Results without the item object, plus the item's position in the corpus,
// which also proves the result carries the corpus object itself, not a copy.
function snapshot(results, database) {
    return results.map(({ item, ...rest }) => ({ ...rest, itemIndex: database.indexOf(item) }));
}

function e2eCases(queries, getQueryVariants, database) {
    const cases = [];
    const seen = new Set();
    for (const { query } of queries) {
        const { lexicalQuery } = getQueryVariants(query, database);
        for (const q of [query, lexicalQuery]) {
            for (const resultLimit of RESULT_LIMITS) {
                const key = `${q}\u0000${resultLimit}`;
                if (!seen.has(key)) { seen.add(key); cases.push({ q, resultLimit }); }
            }
        }
    }
    return cases;
}

async function main() {
    const started = Date.now();
    const matcherPath = require.resolve('../../src/search/fuzzy-matcher');
    require.cache[matcherPath] = { id: matcherPath, filename: matcherPath, loaded: true, exports: { createFuzzyMatcher: fuseMatcher } };
    const { keywordSearchOnly, getQueryVariants } = require('../../src/search/search-logic');
    const { database, config, lists } = await loadContext();
    const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
    const cases = e2eCases(queries, getQueryVariants, database);
    cases.forEach((c, i) => {
        c.r = snapshot(keywordSearchOnly(c.q, database, config, c.resultLimit ? { resultLimit: c.resultLimit } : {}), database);
        if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${cases.length}`);
    });
    fs.writeFileSync(E2E_ORACLE_PATH, `${JSON.stringify({ generator: 'benchmark/fuzzy/build-e2e-oracle.js', runtime: recordingRuntime(), corpusSha256: corpusSha(lists), cases })}\n`);
    console.log(`Wrote ${cases.length} cases to benchmark/fuzzy/e2e-oracle.json in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

module.exports = { E2E_ORACLE_PATH, snapshot };
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

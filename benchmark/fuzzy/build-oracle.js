#!/usr/bin/env node
'use strict';
// Records every fuzzy-matcher call that search-logic makes for the query set
// (keyword-only and hybrid paths, default and maximum result windows), then
// stores what fuse.js 7.1 returns for each call: benchmark/fuzzy/oracle.json.
//
// The oracle always comes from fuse.js itself (a devDependency), never from
// src/search/fuzzy-matcher.js, so it stays valid while the matcher is replaced.
// Regenerate only when the corpus or the matcher options change.
const fs = require('node:fs');
const path = require('node:path');
const Fuse = require('fuse.js');
const { ORACLE_PATH, QUERIES_PATH, ORACLE_LIMIT, loadContext, listNameFor, corpusSha, recordingRuntime } = require('./lib');

async function recordCalls() {
    const matcherModule = require('../../src/search/fuzzy-matcher');
    const original = matcherModule.createFuzzyMatcher;
    const calls = new Map();
    const profiles = new Map();
    // search-logic reads createFuzzyMatcher when it loads, so patch first.
    matcherModule.createFuzzyMatcher = (list, options) => {
        const profileKey = JSON.stringify(options);
        if (!profiles.has(profileKey)) profiles.set(profileKey, { id: profiles.size, list: listNameFor(options), options });
        const profile = profiles.get(profileKey);
        const matcher = original(list, options);
        return {
            search(query, searchOptions) {
                calls.set(`${profile.id}\u0000${query}`, { p: profile.id, q: query });
                return matcher.search(query, searchOptions);
            }
        };
    };
    const { keywordSearchOnly, getQueryVariants } = require('../../src/search/search-logic');
    const { database, config, lists } = await loadContext();
    const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
    queries.forEach(({ query }, index) => {
        // keyword-only path, then the lexical variant the hybrid path sends.
        const { lexicalQuery } = getQueryVariants(query, database);
        for (const q of new Set([query, lexicalQuery])) {
            keywordSearchOnly(q, database, config, { resultLimit: 51 });
        }
        if ((index + 1) % 50 === 0) console.error(`  recorded ${index + 1}/${queries.length} queries`);
    });
    matcherModule.createFuzzyMatcher = original;
    return { lists, profiles: [...profiles.values()], calls: [...calls.values()] };
}

function fuseVersion() {
    // fuse.js does not export its package.json; read it next to dist/.
    const entry = require.resolve('fuse.js');
    const packageJson = path.join(entry.slice(0, entry.lastIndexOf(`${path.sep}dist${path.sep}`)), 'package.json');
    return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
}

async function main() {
    const started = Date.now();
    const { lists, profiles, calls } = await recordCalls();
    console.error(`Recorded ${calls.length} distinct calls across ${profiles.length} profiles; computing fuse.js results…`);
    const fuses = profiles.map(p => new Fuse(lists[p.list], { ...p.options, includeScore: true }));
    for (const call of calls) {
        call.r = fuses[call.p].search(call.q, { limit: ORACLE_LIMIT }).map(r => [r.refIndex, r.score]);
    }
    const oracle = {
        generator: 'benchmark/fuzzy/build-oracle.js',
        fuseVersion: fuseVersion(),
        runtime: recordingRuntime(),
        corpusSha256: corpusSha(lists),
        limit: ORACLE_LIMIT,
        profiles,
        calls
    };
    fs.writeFileSync(ORACLE_PATH, `${JSON.stringify(oracle)}\n`);
    console.log(`Wrote ${calls.length} calls to benchmark/fuzzy/oracle.json in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch(error => { console.error(error); process.exit(1); });

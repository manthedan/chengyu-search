#!/usr/bin/env node
'use strict';
// Scoreboard for the fuzzy-matcher work. Prints one JSON object:
//   parity    must be { mismatches: 0 } for any change to be kept
//   runtime   warm end-to-end keywordSearchOnly() latency over the query set
//   cold      fresh-process first-query latency (includes index build) and heap
//   footprint fuzzy-matching code loaded at runtime, production dependencies
//
//   node benchmark/fuzzy/scoreboard.js [--passes 3] [--skip-parity] [--out file.json]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { QUERIES_PATH, loadContext, loadOracle, checkParity } = require('./lib');

const ROOT = path.join(__dirname, '..', '..');
const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
};

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
function summarize(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const round = n => Math.round(n * 1000) / 1000;
    return {
        n: sorted.length,
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        max: round(sorted.at(-1) || 0),
        mean: round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1))
    };
}

async function runtime(passes) {
    const { keywordSearchOnly } = require('../../src/search/search-logic');
    const { database, config } = await loadContext();
    const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
    for (const { query } of queries) keywordSearchOnly(query, database, config); // warm-up and index build
    const perQuery = queries.map(() => []);
    for (let pass = 0; pass < passes; pass++) {
        queries.forEach(({ query }, i) => {
            const start = performance.now();
            keywordSearchOnly(query, database, config);
            perQuery[i].push(performance.now() - start);
        });
    }
    const medians = perQuery.map(times => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]);
    const byGroup = {};
    queries.forEach(({ route }, i) => {
        const group = route.split(':')[0];
        (byGroup[group] ||= []).push(medians[i]);
    });
    return {
        unit: 'ms',
        passes,
        all: summarize(medians),
        totalMs: Math.round(medians.reduce((a, b) => a + b, 0)),
        byGroup: Object.fromEntries(Object.entries(byGroup).map(([group, times]) => [group, summarize(times)]))
    };
}

// Measured in a fresh process so module caches and JIT state do not leak in.
function cold() {
    const script = `
        process.env.QUIET_LOGS = '1';
        const before = new Set(Object.keys(require.cache));
        const t0 = performance.now();
        require('./src/search/fuzzy-matcher');
        const requireMs = performance.now() - t0;
        const loaded = Object.keys(require.cache).filter(f => !before.has(f));
        const { keywordSearchOnly } = require('./src/search/search-logic');
        const { loadChengyuCorpus } = require('./src/data/corpus-loader');
        const config = require('./src/search/search-config');
        loadChengyuCorpus().then(({ database }) => {
            global.gc(); const mem0 = process.memoryUsage();
            let t = performance.now(); keywordSearchOnly('easier said than done', database, config); const english = performance.now() - t;
            t = performance.now(); keywordSearchOnly('hua she tian zu', database, config); const pinyin = performance.now() - t;
            t = performance.now(); keywordSearchOnly('画蛇', database, config); const chinese = performance.now() - t;
            global.gc(); const mem1 = process.memoryUsage();
            const heapMb = (mem1.heapUsed - mem0.heapUsed) / 1048576;
            const memoryMb = heapMb + (mem1.arrayBuffers - mem0.arrayBuffers) / 1048576;
            const bytes = loaded.reduce((sum, f) => sum + require('fs').statSync(f).size, 0);
            console.log(JSON.stringify({ requireMs, english, pinyin, chinese, heapMb, memoryMb, loaded: loaded.map(f => require('path').relative(process.cwd(), f)), bytes }));
        });`;
    const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', script], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
    const round = n => Math.round(n * 10) / 10;
    return {
        firstQueryMs: { english: round(out.english), pinyin: round(out.pinyin), chinese: round(out.chinese) },
        matcherRequireMs: round(out.requireMs),
        indexHeapMb: round(out.heapMb),
        // heap plus typed-array backing stores, which heapUsed does not count
        indexMemoryMb: round(out.memoryMb),
        footprint: { fuzzyCodeBytes: out.bytes, fuzzyModules: out.loaded }
    };
}

function productionDependencies() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {}).sort();
}

async function main() {
    const passes = Number(arg('--passes', 3));
    const board = { generatedAt: new Date().toISOString() };
    if (!process.argv.includes('--skip-parity')) {
        const { createFuzzyMatcher } = require('../../src/search/fuzzy-matcher');
        const { lists } = await loadContext();
        const result = checkParity(createFuzzyMatcher, loadOracle(), lists);
        board.parity = { calls: result.calls, checks: result.checks, mismatches: result.mismatches.length, firstMismatches: result.mismatches.slice(0, 3) };
    }
    board.runtime = await runtime(passes);
    const coldStats = cold();
    board.cold = { firstQueryMs: coldStats.firstQueryMs, matcherRequireMs: coldStats.matcherRequireMs, indexHeapMb: coldStats.indexHeapMb, indexMemoryMb: coldStats.indexMemoryMb };
    board.footprint = { ...coldStats.footprint, productionDependencies: productionDependencies() };
    const json = JSON.stringify(board, null, 2);
    const out = arg('--out');
    if (out) fs.writeFileSync(out, `${json}\n`);
    console.log(json);
}

main().catch(error => { console.error(error); process.exit(1); });

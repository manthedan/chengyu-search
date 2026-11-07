'use strict';
// Shared pieces of the fuzzy-matcher harness: corpus/profile reconstruction,
// the oracle format, and the parity check used by the test and scoreboard.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ORACLE_PATH = path.join(__dirname, 'oracle.json');
const QUERIES_PATH = path.join(__dirname, 'queries.json');
// Largest window any caller requests: hybrid asks for 2 × the 51-row result
// window. Parity is checked at every limit callers use.
const ORACLE_LIMIT = 102;
const PARITY_LIMITS = [15, 20, 51, 102];

async function loadContext() {
    process.env.QUIET_LOGS = '1';
    const { loadChengyuCorpus } = require('../../src/data/corpus-loader');
    const { normalizePinyin } = require('../../src/search/search-logic');
    const config = require('../../src/search/search-config');
    const { database } = await loadChengyuCorpus();
    const lists = {
        corpus: database,
        pinyin: database.map(c => ({ ...c, pinyin_norm: normalizePinyin(c.pinyin) }))
    };
    return { database, config, lists };
}

// Identifies which list a matcher was built over, from the keys it searches.
function listNameFor(options) {
    return options.keys.some(key => key.name === 'pinyin_norm') ? 'pinyin' : 'corpus';
}

function corpusSha(lists) {
    const hash = crypto.createHash('sha256');
    for (const name of ['corpus', 'pinyin']) {
        for (const e of lists[name]) {
            hash.update(JSON.stringify([e.chengyu, e.pinyin, e.pinyin_norm, e.meaning, e.literal, e.example, e.tags]));
        }
    }
    return hash.digest('hex');
}

// Oracles store exact score bits, which depend on the V8 that recorded them:
// Math.pow can round differently in the last bit across V8 versions (fuse.js and
// the matcher still agree on any one runtime). On the recording V8, scores must
// be identical; on any other, within this relative tolerance. Order and items
// are always exact.
const FOREIGN_RUNTIME_TOLERANCE = 1e-12;

function recordingRuntime() {
    return { node: process.version, v8: process.versions.v8 };
}

function sameScore(expected, actual, oracle) {
    if (expected === actual) return true;
    if (oracle.runtime && oracle.runtime.v8 === process.versions.v8) return false;
    return Math.abs(expected - actual) <= FOREIGN_RUNTIME_TOLERANCE * Math.max(Math.abs(expected), Math.abs(actual));
}

function loadOracle() {
    return JSON.parse(fs.readFileSync(ORACLE_PATH, 'utf8'));
}

/**
 * Compares a matcher implementation with the oracle.
 * @param {(list: object[], options: object) => { search(q: string, o?: { limit?: number }): any[] }} createMatcher
 * @returns {{ calls: number, checks: number, mismatches: Array<object> }}
 */
function checkParity(createMatcher, oracle, lists, { limits = PARITY_LIMITS, maxReported = 10 } = {}) {
    const matchers = oracle.profiles.map(profile => createMatcher(lists[profile.list], profile.options));
    const mismatches = [];
    let checks = 0;
    for (const call of oracle.calls) {
        const list = lists[oracle.profiles[call.p].list];
        for (const limit of limits) {
            checks++;
            const expected = call.r.slice(0, limit);
            const actual = matchers[call.p].search(call.q, { limit });
            const problem = compare(expected, actual, list, oracle);
            if (problem) {
                mismatches.push({ profile: call.p, query: call.q, limit, ...problem });
                if (mismatches.length >= maxReported) return { calls: oracle.calls.length, checks, mismatches, truncated: true };
                break;
            }
        }
    }
    return { calls: oracle.calls.length, checks, mismatches };
}

function compare(expected, actual, list, oracle) {
    if (actual.length !== expected.length) return { problem: 'length', expected: expected.length, actual: actual.length };
    for (let i = 0; i < expected.length; i++) {
        const [refIndex, score] = expected[i];
        const row = actual[i];
        if (row.refIndex !== refIndex) return { problem: 'order', at: i, expected: refIndex, actual: row.refIndex };
        if (row.item !== list[refIndex]) return { problem: 'item', at: i };
        if (!sameScore(score, row.score, oracle)) return { problem: 'score', at: i, expected: score, actual: row.score };
    }
    return null;
}

module.exports = { ORACLE_PATH, QUERIES_PATH, ORACLE_LIMIT, PARITY_LIMITS, loadContext, listNameFor, corpusSha, loadOracle, checkParity, recordingRuntime, sameScore };

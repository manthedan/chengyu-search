'use strict';
const { classifyQueryType } = require('./search-logic');
const { exactHeadwordMatches, normalizeChineseQuery } = require('../data/chinese-query');
const { hasHan } = require('../data/chinese-normalizer/normalize');
const { scanQwen } = require('../embeddings/qwen-index');
const { rankCollapsed } = require('./variant-grouping');
// A hosted result is 'weak' when its top score stands less than WEAK_MATCH_Z standard deviations above the
// corpus mean. Calibrated 2026-11-06 on the v3 dev split plus the release-gate queries (experiments/search-quality-v1):
// it flags about 5% of real queries and about half of keyboard-mash nonsense, so the UI words it softly.
const WEAK_MATCH_Z = 3.85;
function matchStrength(ranked, stats) {
    if (!ranked.length || !(stats.std > 0)) return 'weak';
    return (ranked[0].score - stats.mean) / stats.std < WEAK_MATCH_Z ? 'weak' : 'normal';
}
const UNAVAILABLE_MESSAGE = 'Description search is temporarily unavailable. Try an English description, an exact idiom, or pinyin lookup.';

function isHostedDescription(query, database) {
    if (!query.trim() || classifyQueryType(query) === 'pinyin') return false;
    if (exactHeadwordMatches(query, database).length) return false;
    if (hasHan(query)) {
        const normalized = normalizeChineseQuery(query, database);
        if (exactHeadwordMatches(normalized, database).length || [...normalized].length <= 4) return false;
    }
    return true;
}

function withHostedSearch({ execute, mode, client, getIndex, getDatabase, getPrior = () => null, getVariantFamilies = () => null, isFallbackReady, executeLexicalFallback,
    normalizePagination, createHttpError, createResponse }) {
    return async (query, options = {}) => {
        if (!options.statusOnly && ((!client.enabled && !client.requested) || !isHostedDescription(query, getDatabase()))) return execute(query, options);
        const pagination = normalizePagination(options, { createHttpError });
        const index = getIndex();
        const result = !client.enabled ? { vector: null, reason: client.requested ? 'credentials' : 'off' } : !index ? { vector: null, reason: 'artifact' }
            : options.statusOnly ? client.peek(query, options.hostedRequestId) : await client.get(query);
        if (result.vector) {
            const stats = {};
            // Continuations (statusOnly) take this same path, so they collapse identically.
            const rankedResults = await rankCollapsed(getVariantFamilies(), pagination.requestedWindow,
                window => scanQwen(index, result.vector, window, getPrior()?.adjustments, stats));
            return { ...createResponse({ query, mode: 'semantic', queryType: classifyQueryType(query), preferredMode: 'semantic',
                autoRouted: mode === 'auto', rankedResults, offset: pagination.offset, limit: pagination.limit }),
                status: 'complete', embeddingSource: 'hosted-qwen', matchStrength: matchStrength(rankedResults, stats) };
        }
        const pending = result.reason === 'timeout' && Boolean(result.requestId);
        const state = { query, status: pending ? 'pending' : 'unavailable', results: [], count: 0,
            offset: pagination.offset, limit: pagination.limit, hasMore: false, nextOffset: null,
            embeddingSource: pending ? 'pending' : 'unavailable', hostedFallbackReason: result.reason,
            ...(pending ? { hostedRequestId: result.requestId } : { message: UNAVAILABLE_MESSAGE }) };
        // Chinese descriptions have no useful lexical fallback. Continuations
        // are strictly read-only, including after errors, eviction, or restart.
        if (hasHan(query) || options.statusOnly) return state;
        // Fallback rankings use their existing cache. This wrapper always tries
        // the hosted embedding first, so a timeout never pins fallback results.
        const response = await (mode === 'semantic' && !isFallbackReady() ? executeLexicalFallback : execute)(query, options);
        // An empty fallback is not a completed search while hosted work is
        // still pending. Use the same continuation as Chinese descriptions.
        if (pending && !response.results.length) return state;
        return { ...response, status: 'complete',
            embeddingSource: isFallbackReady() && response.mode !== 'keyword' ? 'minilm-fallback' : 'lexical-fallback',
            hostedFallbackReason: result.reason,
            ...(pending ? { hostedRequestId: result.requestId } : { message: UNAVAILABLE_MESSAGE }) };
    };
}
module.exports = { isHostedDescription, withHostedSearch, matchStrength, WEAK_MATCH_Z, UNAVAILABLE_MESSAGE };

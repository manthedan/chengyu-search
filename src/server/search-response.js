/** @ts-check */

/**
 * @typedef {import('../search/types').ChengyuEntry} ChengyuEntry
 * @typedef {import('../search/types').ChengyuId} ChengyuId
 * @typedef {import('../search/types').QueryType} QueryType
 * @typedef {import('../search/types').SearchMode} SearchMode
 * @typedef {import('../search/types').RankedCandidate} RankedCandidate
 * @typedef {RankedCandidate & { item?: ChengyuEntry }} RankedSearchResult
 * @typedef {object} ResultPayload
 * @property {ChengyuId | undefined} id
 * @property {string} chengyu
 * @property {string} simplified
 * @property {string} traditional
 * @property {string | undefined} pinyin
 * @property {string | undefined} literal
 * @property {string | undefined} meaning
 * @property {string | undefined} example
 * @property {readonly string[] | undefined} tags
 * @property {string | undefined} formality
 * @property {number} relevance_score
 */

/**
 * @param {number | undefined} score
 * @returns {number}
 */
function clampRelevanceScore(score) {
    return Math.max(0, Math.min(100, Math.round((score || 0) * 100)));
}

/**
 * @param {readonly RankedSearchResult[]} rankedResults
 * @param {object} [options]
 * @param {ReadonlyMap<ChengyuId, ChengyuEntry>} [options.byId]
 * @returns {ResultPayload[]}
 */
function buildResultPayload(rankedResults, { byId = new Map() } = {}) {
    /** @type {ResultPayload[]} */
    const payloads = [];
    rankedResults.forEach(({ item, id, chengyu, score }) => {
        const entry = item || (id ? byId.get(id) : undefined);
        if (!entry) return;
        payloads.push({
            id: entry.id,
            chengyu: entry.chengyu,
            simplified: entry.simplified || entry.chengyu,
            traditional: entry.traditional || entry.chengyu,
            pinyin: entry.pinyin,
            literal: entry.literal,
            meaning: entry.meaning,
            example: entry.example,
            tags: entry.tags,
            formality: entry.formality,
            relevance_score: clampRelevanceScore(score)
        });
    });
    return payloads;
}

/**
 * @param {readonly RankedSearchResult[]} rankedResults
 * @param {object} [options]
 * @param {number} [options.offset]
 * @param {number} [options.limit]
 * @returns {readonly RankedSearchResult[]}
 */
function sliceRankedResults(rankedResults, { offset = 0, limit = 10 } = {}) {
    return rankedResults.slice(offset, offset + limit);
}

/**
 * @param {object} options
 * @param {string} options.query
 * @param {SearchMode} options.mode
 * @param {QueryType | string | undefined} [options.queryType]
 * @param {SearchMode} [options.preferredMode]
 * @param {boolean} [options.autoRouted]
 * @param {SearchMode | null} [options.fallbackFrom]
 * @param {number} [options.offset]
 * @param {number} [options.limit]
 * @param {boolean} [options.hasMore]
 * @param {ResultPayload[]} options.results
 * @returns {{query: string, mode: SearchMode, queryType: QueryType | string | undefined, preferredMode: SearchMode, autoRouted: boolean, fallbackFrom: SearchMode | null, offset: number, limit: number, count: number, hasMore: boolean, nextOffset: number | null, results: ResultPayload[]}}
 */
function createSearchResponse({
    query,
    mode,
    queryType,
    preferredMode = mode,
    autoRouted = false,
    fallbackFrom = null,
    offset = 0,
    limit = 10,
    hasMore = false,
    results
}) {
    return {
        query,
        mode,
        queryType,
        preferredMode,
        autoRouted,
        fallbackFrom,
        offset,
        limit,
        count: results.length,
        hasMore,
        nextOffset: hasMore ? offset + results.length : null,
        results
    };
}

/**
 * @param {object} options
 * @param {string} options.query
 * @param {SearchMode} options.mode
 * @param {QueryType | string | undefined} [options.queryType]
 * @param {SearchMode} [options.preferredMode]
 * @param {boolean} [options.autoRouted]
 * @param {SearchMode | null} [options.fallbackFrom]
 * @param {readonly RankedSearchResult[]} options.rankedResults
 * @param {ReadonlyMap<ChengyuId, ChengyuEntry>} options.byId
 * @param {number} [options.offset]
 * @param {number} [options.limit]
 * @returns {{query: string, mode: SearchMode, queryType: QueryType | string | undefined, preferredMode: SearchMode, autoRouted: boolean, fallbackFrom: SearchMode | null, offset: number, limit: number, count: number, hasMore: boolean, nextOffset: number | null, results: ResultPayload[]}}
 */
function createPaginatedSearchResponse({
    query,
    mode,
    queryType,
    preferredMode = mode,
    autoRouted = false,
    fallbackFrom = null,
    rankedResults,
    byId,
    offset = 0,
    limit = 10
}) {
    const pagedResults = buildResultPayload(sliceRankedResults(rankedResults, { offset, limit }), { byId });
    const hasMore = rankedResults.length > offset + limit;

    return createSearchResponse({
        query,
        mode,
        queryType,
        preferredMode,
        autoRouted,
        fallbackFrom,
        offset,
        limit,
        hasMore,
        results: pagedResults
    });
}

module.exports = {
    clampRelevanceScore,
    buildResultPayload,
    sliceRankedResults,
    createSearchResponse,
    createPaginatedSearchResponse
};

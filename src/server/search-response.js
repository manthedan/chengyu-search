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
 * @property {string | undefined} meaning_zh
 * @property {'chengyu' | 'set_phrase' | 'official_political' | 'technical_or_proper' | undefined} kind
 * @property {string | undefined} example
 * @property {readonly string[] | undefined} tags
 * @property {string | undefined} formality
 * @property {number} relevance_score
 * @property {ReadonlyArray<VariantPayload>} variants other forms of this idiom (empty when none or grouping is off)
 * @typedef {object} VariantPayload
 * @property {string} simplified
 * @property {string} traditional
 * @property {string | undefined} pinyin
 * @property {string} publicId
 * @property {'same' | 'full_form'} relation
 * @property {boolean} preferred the form a meaning search shows for this family
 * @property {boolean} common its own cluster's usual spelling
 * @typedef {{ variantsOf: (entry: ChengyuEntry) => ReadonlyArray<VariantPayload>, displayEntry: (entry: ChengyuEntry, query?: string) => ChengyuEntry }} VariantFamilies
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
 * @param {VariantFamilies | null} [options.variantFamilies]
 * @param {string} [options.query] the user's query; a form typed exactly is never swapped
 * @param {boolean} [options.showCommonForm] show each family's most common form (meaning searches only)
 * @returns {ResultPayload[]}
 */
function buildResultPayload(rankedResults, { byId = new Map(), variantFamilies = null, query = '', showCommonForm = false } = {}) {
    /** @type {ResultPayload[]} */
    const payloads = [];
    rankedResults.forEach(({ item, id, chengyu, score }) => {
        const ranked = item || (id ? byId.get(id) : undefined);
        if (!ranked) return;
        // A collapsed family is shown in its most common form, keeping the ranked score.
        const entry = variantFamilies && showCommonForm ? variantFamilies.displayEntry(ranked, query) : ranked;
        payloads.push({
            id: entry.id,
            chengyu: entry.chengyu,
            simplified: entry.simplified || entry.chengyu,
            traditional: entry.traditional || entry.chengyu,
            pinyin: entry.pinyin,
            literal: entry.literal,
            meaning: entry.meaning,
            meaning_zh: entry.meaning_zh,
            kind: entry.kind,
            example: entry.example,
            tags: entry.tags,
            formality: entry.formality,
            relevance_score: clampRelevanceScore(score),
            variants: variantFamilies ? variantFamilies.variantsOf(entry) : []
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
 * @param {VariantFamilies | null} [options.variantFamilies]
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
    variantFamilies = null,
    offset = 0,
    limit = 10
}) {
    // rankedResults are already variant-collapsed (see rankCollapsed).
    // Only meaning searches show a family's most common form: a character or
    // pinyin search shows the form that matched what was typed.
    const pagedResults = buildResultPayload(sliceRankedResults(rankedResults, { offset, limit }),
        { byId, variantFamilies, query, showCommonForm: mode === 'semantic' });
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

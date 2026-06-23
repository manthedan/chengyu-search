function clampRelevanceScore(score) {
    return Math.max(0, Math.min(100, Math.round((score || 0) * 100)));
}

function buildResultPayload(rankedResults, { byId = new Map() } = {}) {
    return rankedResults
        .map(({ item, id, chengyu, score }) => {
            const entry = item || byId.get(id);
            if (!entry) return null;
            return {
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
            };
        })
        .filter(Boolean);
}

function sliceRankedResults(rankedResults, { offset = 0, limit = 10 } = {}) {
    return rankedResults.slice(offset, offset + limit);
}

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

'use strict';
const DEFAULT_PRIMARY_TYPES = ['english_meaning', 'thematic'];
const DEFAULT_SEMANTIC_ROUTED_TYPES = ['english_meaning', 'thematic', 'literal'];

function dcg(relevances, k) {
    let score = 0;
    for (let i = 0; i < Math.min(relevances.length, k); i++) {
        score += relevances[i] / Math.log2(i + 2);
    }
    return score;
}

function ndcg(actualResults, expectedResults, k = 5) {
    const relMap = new Map(expectedResults.map(entry => [entry.chengyu, entry.relevance]));
    const actualRels = actualResults.slice(0, k).map(result => relMap.get(result.chengyu) || 0);
    const idealRels = expectedResults
        .map(entry => entry.relevance)
        .sort((a, b) => b - a)
        .slice(0, k);

    const actualDCG = dcg(actualRels, k);
    const idealDCG = dcg(idealRels, k);
    if (idealDCG === 0) return 0;
    return actualDCG / idealDCG;
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 6) {
    return Number(value.toFixed(digits));
}

function summarizeScores(
    perQuery,
    primaryTypes = DEFAULT_PRIMARY_TYPES,
    semanticRoutedTypes = DEFAULT_SEMANTIC_ROUTED_TYPES
) {
    const primarySet = new Set(primaryTypes);
    const semanticRoutedSet = new Set(semanticRoutedTypes);
    const primaryScores = [];
    const semanticRoutedScores = [];
    const overallScores = [];
    const byType = {};

    perQuery.forEach(item => {
        overallScores.push(item.ndcg);
        if (!byType[item.type]) byType[item.type] = [];
        byType[item.type].push(item.ndcg);
        if (primarySet.has(item.type)) {
            primaryScores.push(item.ndcg);
        }
        if (semanticRoutedSet.has(item.type)) {
            semanticRoutedScores.push(item.ndcg);
        }
    });

    const typeScores = {};
    Object.entries(byType).forEach(([type, scores]) => {
        typeScores[type] = round(average(scores), 4);
    });

    const primaryAvg = average(primaryScores);
    const semanticRoutedAvg = average(semanticRoutedScores);
    const overallAvg = average(overallScores);

    return {
        avg_ndcg: round(primaryAvg),
        primary_avg_ndcg: round(primaryAvg),
        overall_avg_ndcg: round(overallAvg),
        semantic_routed_types: [...semanticRoutedTypes],
        semantic_routed_avg_ndcg: round(semanticRoutedAvg),
        semantic_routed_query_count: semanticRoutedScores.length,
        primary_query_count: primaryScores.length,
        total_query_count: overallScores.length,
        by_type: typeScores
    };
}

module.exports = {dcg, ndcg, average, round, summarizeScores};

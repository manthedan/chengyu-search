#!/usr/bin/env node
const {
    DEFAULT_PRIMARY_TYPES,
    benchmarkLatencyMode,
    benchmarkMode,
    loadTestSet,
    parseArgs,
    parseList,
    splitHoldoutTestSet,
    startBenchmarkServer,
    stratifiedSample,
    suppressConsoleLog
} = require('./lib.js');

const DEFAULT_EVAL_MODES = ['auto', 'semantic', 'hybrid'];

function summarizeModeRanking(results) {
    const overallRanking = [...results]
        .sort((a, b) => b.overall_avg_ndcg - a.overall_avg_ndcg)
        .map(result => result.mode);
    const primaryRanking = [...results]
        .sort((a, b) => b.primary_avg_ndcg - a.primary_avg_ndcg)
        .map(result => result.mode);
    const semanticRoutedRanking = [...results]
        .sort((a, b) => b.semantic_routed_avg_ndcg - a.semantic_routed_avg_ndcg)
        .map(result => result.mode);

    return {
        best_overall_mode: overallRanking[0],
        best_primary_mode: primaryRanking[0],
        best_semantic_routed_mode: semanticRoutedRanking[0],
        ranking: {
            overall: overallRanking,
            primary: primaryRanking,
            semantic_routed: semanticRoutedRanking
        },
        modes: results
    };
}

function modeMap(results) {
    return Object.fromEntries(results.map(result => [result.mode, result]));
}

async function benchmarkSplit({
    baseUrl,
    label,
    testSet,
    modes,
    primaryTypes,
    verbose,
    includePerQuery
}) {
    const results = [];
    for (const mode of modes) {
        results.push(await benchmarkMode({
            baseUrl,
            testSet,
            mode,
            primaryTypes,
            verbose,
            includePerQuery
        }));
    }

    return {
        label,
        query_count: testSet.length,
        ...summarizeModeRanking(results)
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const modes = parseList(args.modes, DEFAULT_EVAL_MODES);
    const latencyModes = parseList(args['latency-modes'], modes);
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const includePerQuery = Boolean(args['include-per-query']);
    const holdoutRatio = Number(args['holdout-ratio'] || 0.25);
    const seed = String(args.seed || 'holdout-v1');
    const latencyPerType = Number(args['latency-per-type'] || 1);
    const warmup = Number(args.warmup || 1);
    const variantId = String(args['variant-id'] || process.env.BAKEOFF_VARIANT_ID || 'custom');
    const variantLabel = String(args['variant-label'] || process.env.BAKEOFF_VARIANT_LABEL || variantId);

    const testSet = loadTestSet();
    const split = splitHoldoutTestSet(testSet, { holdoutRatio, seed });
    const latencyQueries = stratifiedSample(testSet, latencyPerType);

    const { summary, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });
        const healthResponse = await fetch(`${serverHandle.baseUrl}/api/health`);
        const health = await healthResponse.json();

        try {
            const full = await benchmarkSplit({
                baseUrl: serverHandle.baseUrl,
                label: 'full',
                testSet,
                modes,
                primaryTypes,
                verbose,
                includePerQuery
            });
            const development = await benchmarkSplit({
                baseUrl: serverHandle.baseUrl,
                label: 'development',
                testSet: split.developmentSet,
                modes,
                primaryTypes,
                verbose,
                includePerQuery
            });
            const holdout = await benchmarkSplit({
                baseUrl: serverHandle.baseUrl,
                label: 'holdout',
                testSet: split.holdoutSet,
                modes,
                primaryTypes,
                verbose,
                includePerQuery
            });

            const latencyResults = [];
            for (const mode of latencyModes) {
                latencyResults.push(await benchmarkLatencyMode({
                    baseUrl: serverHandle.baseUrl,
                    mode,
                    queries: latencyQueries,
                    warmup,
                    verbose
                }));
            }

            const fullByMode = modeMap(full.modes);
            const holdoutByMode = modeMap(holdout.modes);
            const latencyByMode = modeMap(latencyResults);

            return {
                baseUrl: serverHandle.baseUrl,
                summary: {
                    benchmark: 'embedding-variant-evaluation',
                    variant: {
                        id: variantId,
                        label: variantLabel,
                        embedding_file: health.embeddingFile || process.env.EMBEDDINGS_FILE || null,
                        configured_embedding_model: health.configuredEmbeddingModel || process.env.EMBEDDING_MODEL_ID || null,
                        loaded_embedding_model: health.loadedEmbeddingModel || null,
                        embedding_template: health.embeddingTemplate || null,
                        embedding_dimensions: health.embeddingDimensions || null
                    },
                    server_health: health,
                    modes,
                    latency_modes: latencyModes,
                    primary_types: primaryTypes,
                    full,
                    holdout: {
                        split: split.summary,
                        development,
                        holdout
                    },
                    latency: {
                        sample_size: latencyQueries.length,
                        sampled_queries: latencyQueries,
                        warmup,
                        modes: latencyResults
                    },
                    headline: {
                        auto_full_overall_avg_ndcg: fullByMode.auto ? fullByMode.auto.overall_avg_ndcg : null,
                        auto_full_semantic_routed_avg_ndcg: fullByMode.auto ? fullByMode.auto.semantic_routed_avg_ndcg : null,
                        auto_holdout_overall_avg_ndcg: holdoutByMode.auto ? holdoutByMode.auto.overall_avg_ndcg : null,
                        auto_holdout_semantic_routed_avg_ndcg: holdoutByMode.auto ? holdoutByMode.auto.semantic_routed_avg_ndcg : null,
                        semantic_holdout_semantic_routed_avg_ndcg: holdoutByMode.semantic ? holdoutByMode.semantic.semantic_routed_avg_ndcg : null,
                        hybrid_holdout_overall_avg_ndcg: holdoutByMode.hybrid ? holdoutByMode.hybrid.overall_avg_ndcg : null,
                        semantic_cold_avg_ms: latencyByMode.semantic ? latencyByMode.semantic.cold.avg_ms : null,
                        auto_cold_avg_ms: latencyByMode.auto ? latencyByMode.auto.cold.avg_ms : null,
                        hybrid_cold_avg_ms: latencyByMode.hybrid ? latencyByMode.hybrid.cold.avg_ms : null
                    },
                    timestamp: new Date().toISOString()
                }
            };
        } finally {
            await serverHandle.close();
        }
    });

    console.log(JSON.stringify(summary));

    console.error(`Evaluated variant ${summary.variant.id} against ${baseUrl}`);
    console.error(`Embedding file: ${summary.variant.embedding_file}`);
    console.error(`Embedding model: ${summary.variant.configured_embedding_model}`);
    console.error(`Full best semantic-routed mode: ${summary.full.best_semantic_routed_mode}`);
    console.error(`Holdout best semantic-routed mode: ${summary.holdout.holdout.best_semantic_routed_mode}`);
    console.error(`Auto holdout semantic-routed avg_ndcg: ${summary.headline.auto_holdout_semantic_routed_avg_ndcg}`);
    console.error(`Semantic cold avg latency: ${summary.headline.semantic_cold_avg_ms}ms`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

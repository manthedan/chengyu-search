#!/usr/bin/env node
const {
    DEFAULT_MODES,
    DEFAULT_PRIMARY_TYPES,
    benchmarkMode,
    getBenchmarkOutputPath,
    loadTestSet,
    parseArgs,
    parseList,
    splitHoldoutTestSet,
    startBenchmarkServer,
    suppressConsoleLog,
    writeJsonArtifact
} = require('./lib.js');

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

function summarizeModeRanking(results) {
    const overallRanking = [...results]
        .sort((a, b) => b.overall_avg_ndcg - a.overall_avg_ndcg)
        .map(result => result.mode);
    const primaryRanking = [...results]
        .sort((a, b) => b.primary_avg_ndcg - a.primary_avg_ndcg)
        .map(result => result.mode);

    return {
        best_overall_mode: overallRanking[0],
        best_primary_mode: primaryRanking[0],
        ranking: {
            overall: overallRanking,
            primary: primaryRanking
        },
        modes: results
    };
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

function printSplitTable(label, summary) {
    console.error(`\n${label}:`);
    console.error(`${pad('mode', 10)} ${pad('overall', 10)} ${pad('primary', 10)} ${pad('english', 10)} ${pad('thematic', 10)} ${pad('pinyin', 10)} ${pad('literal', 10)} ${pad('partial', 10)} ${pad('chinese', 10)}`);
    for (const result of summary.modes) {
        console.error(`${pad(result.mode, 10)} ${pad(result.overall_avg_ndcg.toFixed(4), 10)} ${pad(result.primary_avg_ndcg.toFixed(4), 10)} ${pad((result.by_type.english_meaning ?? 0).toFixed(4), 10)} ${pad((result.by_type.thematic ?? 0).toFixed(4), 10)} ${pad((result.by_type.pinyin ?? 0).toFixed(4), 10)} ${pad((result.by_type.literal ?? 0).toFixed(4), 10)} ${pad((result.by_type.partial ?? 0).toFixed(4), 10)} ${pad((result.by_type.chinese_exact ?? 0).toFixed(4), 10)}`);
    }
    console.error(`Best overall mode: ${summary.best_overall_mode}`);
    console.error(`Best primary mode: ${summary.best_primary_mode}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const modes = parseList(args.modes, DEFAULT_MODES);
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const outputPath = getBenchmarkOutputPath(args, 'holdout');
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const includePerQuery = Boolean(args['include-per-query']);
    const includeSplitQueries = Boolean(args['include-split-queries']);
    const holdoutRatio = Number(args['holdout-ratio'] || 0.25);
    const seed = String(args.seed || 'holdout-v1');

    const testSet = loadTestSet();
    const split = splitHoldoutTestSet(testSet, {
        holdoutRatio,
        seed
    });

    const { summary, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });

        try {
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

            return {
                baseUrl: serverHandle.baseUrl,
                summary: {
                    benchmark: 'holdout',
                    modes,
                    primary_types: primaryTypes,
                    split: {
                        ...split.summary,
                        ...(includeSplitQueries ? {
                            development_queries: split.developmentSet.map(testCase => ({
                                query: testCase.query,
                                type: testCase.type
                            })),
                            holdout_queries: split.holdoutSet.map(testCase => ({
                                query: testCase.query,
                                type: testCase.type
                            }))
                        } : {})
                    },
                    development,
                    holdout,
                    timestamp: new Date().toISOString()
                }
            };
        } finally {
            await serverHandle.close();
        }
    });

    writeJsonArtifact(outputPath, summary);
    console.log(JSON.stringify(summary));

    console.error(`Benchmarking development vs holdout relevance against ${baseUrl}`);
    console.error(`Split seed: ${summary.split.seed}`);
    console.error(`Holdout ratio: ${summary.split.holdout_ratio}`);
    console.error(`Queries: ${summary.split.development_query_count} development / ${summary.split.holdout_query_count} holdout / ${summary.split.total_query_count} total`);
    console.error('Per-type split:', summary.split.by_type);

    printSplitTable('Development split', summary.development);
    printSplitTable('Holdout split', summary.holdout);
    if (outputPath) {
        console.error(`Saved artifact: ${outputPath}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

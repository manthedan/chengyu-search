#!/usr/bin/env node
const {
    DEFAULT_MODES,
    DEFAULT_PRIMARY_TYPES,
    benchmarkMode,
    getBenchmarkOutputPath,
    parseArgs,
    parseList,
    startBenchmarkServer,
    suppressConsoleLog,
    writeJsonArtifact
} = require('./lib.js');

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const modes = parseList(args.modes, DEFAULT_MODES);
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const outputPath = getBenchmarkOutputPath(args, 'modes');
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const includePerQuery = Boolean(args['include-per-query']);

    const { summary, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });

        try {
            const results = [];
            for (const mode of modes) {
                results.push(await benchmarkMode({
                    baseUrl: serverHandle.baseUrl,
                    mode,
                    primaryTypes,
                    verbose,
                    includePerQuery
                }));
            }

            const overallRanking = [...results]
                .sort((a, b) => b.overall_avg_ndcg - a.overall_avg_ndcg)
                .map(result => result.mode);
            const primaryRanking = [...results]
                .sort((a, b) => b.primary_avg_ndcg - a.primary_avg_ndcg)
                .map(result => result.mode);

            return {
                baseUrl: serverHandle.baseUrl,
                summary: {
                    benchmark: 'modes',
                    primary_types: primaryTypes,
                    best_overall_mode: overallRanking[0],
                    best_primary_mode: primaryRanking[0],
                    ranking: {
                        overall: overallRanking,
                        primary: primaryRanking
                    },
                    modes: results,
                    timestamp: new Date().toISOString()
                }
            };
        } finally {
            await serverHandle.close();
        }
    });

    writeJsonArtifact(outputPath, summary);
    console.log(JSON.stringify(summary));

    console.error(`Benchmarking relevance across modes against ${baseUrl}\n`);
    console.error('Mode comparison:');
    console.error(`${pad('mode', 10)} ${pad('overall', 10)} ${pad('primary', 10)} ${pad('english', 10)} ${pad('thematic', 10)} ${pad('pinyin', 10)} ${pad('literal', 10)} ${pad('partial', 10)} ${pad('chinese', 10)}`);
    for (const result of summary.modes) {
        console.error(`${pad(result.mode, 10)} ${pad(result.overall_avg_ndcg.toFixed(4), 10)} ${pad(result.primary_avg_ndcg.toFixed(4), 10)} ${pad((result.by_type.english_meaning ?? 0).toFixed(4), 10)} ${pad((result.by_type.thematic ?? 0).toFixed(4), 10)} ${pad((result.by_type.pinyin ?? 0).toFixed(4), 10)} ${pad((result.by_type.literal ?? 0).toFixed(4), 10)} ${pad((result.by_type.partial ?? 0).toFixed(4), 10)} ${pad((result.by_type.chinese_exact ?? 0).toFixed(4), 10)}`);
    }
    console.error(`\nBest overall mode: ${summary.best_overall_mode}`);
    console.error(`Best primary mode: ${summary.best_primary_mode}`);
    if (outputPath) {
        console.error(`Saved artifact: ${outputPath}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

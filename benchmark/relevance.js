#!/usr/bin/env node
const {
    DEFAULT_PRIMARY_TYPES,
    benchmarkMode,
    getBenchmarkOutputPath,
    parseArgs,
    parseList,
    startBenchmarkServer,
    suppressConsoleLog,
    writeJsonArtifact
} = require('./lib.js');

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.mode || 'auto';
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const outputPath = getBenchmarkOutputPath(args, 'relevance', mode);
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const includePerQuery = Boolean(args['include-per-query']);

    const { result, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });
        try {
            const result = await benchmarkMode({
                baseUrl: serverHandle.baseUrl,
                mode,
                primaryTypes,
                verbose,
                includePerQuery
            });
            return { result, baseUrl: serverHandle.baseUrl };
        } finally {
            await serverHandle.close();
        }
    });

    writeJsonArtifact(outputPath, result);
    console.log(JSON.stringify(result));
    console.error(`Benchmarking relevance for mode="${mode}" against ${baseUrl}\n`);
    console.error(`=== Relevance Benchmark (${mode}) ===`);
    console.error(`Primary avg_ndcg: ${result.primary_avg_ndcg.toFixed(6)} (${result.primary_query_count} queries)`);
    console.error(`Overall avg_ndcg: ${result.overall_avg_ndcg.toFixed(6)} (${result.total_query_count} queries)`);
    console.error('By type:', result.by_type);
    if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`);
    }
    if (outputPath) {
        console.error(`Saved artifact: ${outputPath}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

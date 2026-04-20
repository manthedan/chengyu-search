#!/usr/bin/env node
const {
    DEFAULT_MODES,
    benchmarkLatencyMode,
    getBenchmarkOutputPath,
    loadTestSet,
    parseArgs,
    parseList,
    startBenchmarkServer,
    stratifiedSample,
    suppressConsoleLog,
    writeJsonArtifact
} = require('./lib.js');

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const modes = parseList(args.modes, DEFAULT_MODES);
    const perType = Number(args['per-type'] || 2);
    const outputPath = getBenchmarkOutputPath(args, 'latency');
    const warmup = Number(args.warmup || 1);
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const port = Number(args.port || (useExisting ? 3000 : 0));

    const testSet = loadTestSet();
    const queries = stratifiedSample(testSet, perType);

    const { summary, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });

        try {
            const results = [];
            for (const mode of modes) {
                results.push(await benchmarkLatencyMode({
                    baseUrl: serverHandle.baseUrl,
                    mode,
                    queries,
                    warmup,
                    verbose
                }));
            }

            return {
                baseUrl: serverHandle.baseUrl,
                summary: {
                    benchmark: 'latency',
                    sample_size: queries.length,
                    sampled_queries: queries,
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

    console.error(`Benchmarking latency across modes against ${baseUrl}`);
    console.error(`Sample size: ${queries.length} queries (${perType} per query type), warmup: ${warmup}\n`);
    console.error('Latency comparison (cold vs warm):');
    console.error(`${pad('mode', 10)} ${pad('cold_avg', 10)} ${pad('cold_p95', 10)} ${pad('warm_avg', 10)} ${pad('warm_p95', 10)}`);
    for (const result of summary.modes) {
        console.error(`${pad(result.mode, 10)} ${pad(result.cold.avg_ms.toFixed(2), 10)} ${pad(result.cold.p95_ms.toFixed(2), 10)} ${pad(result.warm.avg_ms.toFixed(2), 10)} ${pad(result.warm.p95_ms.toFixed(2), 10)}`);
    }
    if (outputPath) {
        console.error(`Saved artifact: ${outputPath}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

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

function formatExpectedResults(items = []) {
    if (!items.length) return '—';
    return items
        .map(item => `${item.chengyu} (${item.relevance})`)
        .join(', ');
}

function formatActualResults(items = []) {
    if (!items.length) return '—';
    return items.join(', ');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.mode || 'auto';
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const top = Number(args.top || 10);
    const outputPath = getBenchmarkOutputPath(args, 'failures', mode);

    const { result, baseUrl } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });
        try {
            const result = await benchmarkMode({
                baseUrl: serverHandle.baseUrl,
                mode,
                primaryTypes,
                verbose,
                includePerQuery: true
            });
            return { result, baseUrl: serverHandle.baseUrl };
        } finally {
            await serverHandle.close();
        }
    });

    const failures = (result.per_query || [])
        .map(entry => ({
            ...entry,
            loss: Number((1 - entry.ndcg).toFixed(6))
        }))
        .sort((a, b) => b.loss - a.loss || a.query.localeCompare(b.query))
        .slice(0, Math.max(1, top));

    const summary = {
        benchmark: 'failures',
        mode,
        endpoint: result.endpoint,
        top,
        primary_types: result.primary_types,
        semantic_routed_types: result.semantic_routed_types,
        query_count: result.total_query_count,
        overall_avg_ndcg: result.overall_avg_ndcg,
        failures,
        timestamp: new Date().toISOString()
    };

    writeJsonArtifact(outputPath, summary);
    console.log(JSON.stringify(summary));

    console.error(`Benchmarking worst-query failures for mode="${mode}" against ${baseUrl}`);
    console.error(`Overall avg_ndcg: ${result.overall_avg_ndcg.toFixed(6)} across ${result.total_query_count} queries`);
    console.error(`Showing worst ${failures.length} queries by NDCG loss\n`);

    failures.forEach((failure, index) => {
        console.error(`#${index + 1} ${failure.query} [${failure.type}]`);
        console.error(`   ndcg: ${failure.ndcg.toFixed(4)} · loss: ${failure.loss.toFixed(4)}`);
        console.error(`   expected: ${formatExpectedResults(failure.expected_top_results)}`);
        console.error(`   actual:   ${formatActualResults(failure.actual_top_results)}`);
        console.error('');
    });

    if (outputPath) {
        console.error(`Saved artifact: ${outputPath}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

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

const DEFAULT_COMPARE_MODES = ['semantic', 'hybrid', 'keyword'];

function getQueryKey(entry) {
    return `${entry.type}::${entry.query}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const verbose = Boolean(args.verbose);
    const useExisting = Boolean(args['use-existing']);
    const port = Number(args.port || (useExisting ? 3000 : 0));
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const compareModes = parseList(args.modes, DEFAULT_COMPARE_MODES);
    const top = Number(args.top || 15);
    const minDelta = Number(args['min-delta'] || 0.05);
    const outputPath = getBenchmarkOutputPath(args, 'route-audit');

    const { baseUrl, autoResult, modeResults } = await suppressConsoleLog(async () => {
        const serverHandle = await startBenchmarkServer({ useExisting, port });

        try {
            const autoResult = await benchmarkMode({
                baseUrl: serverHandle.baseUrl,
                mode: 'auto',
                primaryTypes,
                verbose,
                includePerQuery: true
            });

            const modeResults = [];
            for (const mode of compareModes) {
                modeResults.push(await benchmarkMode({
                    baseUrl: serverHandle.baseUrl,
                    mode,
                    primaryTypes,
                    verbose,
                    includePerQuery: true
                }));
            }

            return {
                baseUrl: serverHandle.baseUrl,
                autoResult,
                modeResults
            };
        } finally {
            await serverHandle.close();
        }
    });

    const perModeByQuery = Object.fromEntries(modeResults.map(result => [
        result.mode,
        new Map((result.per_query || []).map(entry => [getQueryKey(entry), entry]))
    ]));

    const candidates = (autoResult.per_query || [])
        .map(autoEntry => {
            const alternatives = compareModes
                .map(mode => perModeByQuery[mode].get(getQueryKey(autoEntry)))
                .filter(Boolean);
            const bestAlternative = alternatives
                .slice()
                .sort((a, b) => b.ndcg - a.ndcg || a.mode.localeCompare(b.mode))[0];

            if (!bestAlternative) {
                return null;
            }

            const delta = Number((bestAlternative.ndcg - autoEntry.ndcg).toFixed(6));
            return {
                query: autoEntry.query,
                type: autoEntry.type,
                auto_query_type: autoEntry.query_type,
                auto_endpoint_mode: autoEntry.endpoint_mode,
                auto_ndcg: autoEntry.ndcg,
                best_mode: bestAlternative.mode,
                best_ndcg: bestAlternative.ndcg,
                delta,
                auto_actual_top_results: autoEntry.actual_top_results,
                best_actual_top_results: bestAlternative.actual_top_results,
                expected_top_results: autoEntry.expected_top_results
            };
        })
        .filter(Boolean)
        .filter(candidate => candidate.delta >= minDelta && candidate.best_mode !== candidate.auto_endpoint_mode)
        .sort((a, b) => b.delta - a.delta || a.query.localeCompare(b.query));

    const summary = {
        benchmark: 'route-audit',
        primary_types: primaryTypes,
        compare_modes: compareModes,
        min_delta: minDelta,
        query_count: autoResult.total_query_count,
        candidate_count: candidates.length,
        candidates: candidates.slice(0, Math.max(1, top)),
        timestamp: new Date().toISOString()
    };

    writeJsonArtifact(outputPath, summary);
    console.log(JSON.stringify(summary));

    console.error(`Auditing auto-routing against ${baseUrl}`);
    console.error(`Compared auto against: ${compareModes.join(', ')}`);
    console.error(`Flagging queries where the best explicit mode beats auto by at least ${minDelta.toFixed(3)} and uses a different mode.`);
    console.error(`Found ${candidates.length} candidate route mismatches\n`);

    summary.candidates.forEach((candidate, index) => {
        console.error(`#${index + 1} ${candidate.query} [${candidate.type}]`);
        console.error(`   auto: ${candidate.auto_endpoint_mode} (${candidate.auto_ndcg.toFixed(4)})`);
        console.error(`   best explicit: ${candidate.best_mode} (${candidate.best_ndcg.toFixed(4)}) · delta ${candidate.delta.toFixed(4)}`);
        console.error(`   expected: ${candidate.expected_top_results.map(item => `${item.chengyu} (${item.relevance})`).join(', ')}`);
        console.error(`   auto top: ${candidate.auto_actual_top_results.join(', ') || '—'}`);
        console.error(`   best top: ${candidate.best_actual_top_results.join(', ') || '—'}`);
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

#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {evaluateGate} = require('./relevance-gate');
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
    const includePerQuery = Boolean(args['include-per-query'] || args.gate);
    if (args.gate && (mode !== 'auto' || args.primary)) throw Error('The release gate uses production auto routing and the frozen primary types');
    const failOnErrors = Boolean(args['fail-on-errors']);
    const minOverall = args['min-overall'] === undefined ? null : Number(args['min-overall']);
    const minPrimary = args['min-primary'] === undefined ? null : Number(args['min-primary']);

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

    if (args.gate) {
        const bytes = name => fs.readFileSync(path.join(__dirname, '../evaluation/datasets', name));
        const originalBytes = bytes('relevance.json');
        const supplementBytes = bytes('relevance-supplement.json');
        const baseline = JSON.parse(bytes('relevance-baseline.json'));
        const supplement = JSON.parse(supplementBytes);
        const claudeBytes = bytes('relevance-supplement-claude.json');
        const claudeSupplement = JSON.parse(claudeBytes);
        const hash = value => createHash('sha256').update(value).digest('hex');
        if (hash(originalBytes) !== baseline.original_sha256 || hash(originalBytes) !== supplement.provenance.original_sha256 || hash(supplementBytes) !== baseline.supplement_sha256
            || hash(originalBytes) !== claudeSupplement.provenance.original_sha256 || hash(claudeBytes) !== baseline.claude_supplement_sha256 || hash(JSON.stringify(baseline.rows)) !== baseline.rankings_sha256) {
            throw Error('Release gate provenance mismatch: derive the live baseline again under the identical combined labels');
        }
        const gate = evaluateGate({original:JSON.parse(originalBytes), supplement, claudeSupplement, baseline, rows:result.per_query, errors:result.errors});
        console.error(`Original-only reference: overall=${gate.original_only.overall.toFixed(6)} primary=${gate.original_only.primary.toFixed(6)}`);
        console.error(`Combined labels: overall=${gate.combined.overall.toFixed(6)} primary=${gate.combined.primary.toFixed(6)}`);
        console.error(`Live ${baseline.ref.slice(0,7)} combined baseline: overall=${gate.live_combined.overall.toFixed(6)} primary=${gate.live_combined.primary.toFixed(6)}`);
        console.error(`Top-5 label coverage: candidate ${gate.combined.coverage.labeled}/${gate.combined.coverage.slots}; live ${gate.live_combined.coverage.labeled}/${gate.live_combined.coverage.slots}; required 100%`);
        console.log(JSON.stringify({release_gate:gate}));
        writeJsonArtifact(outputPath, {...result, release_gate:gate});
        if (!gate.passed) throw Error(gate.failures.join('\n'));
        console.error('Release gate PASS: no worse than live under identical combined labels');
    }

    if (failOnErrors && result.errors.length > 0) {
        throw new Error(`Relevance benchmark reported ${result.errors.length} request errors`);
    }
    if (minOverall !== null && result.overall_avg_ndcg < minOverall) {
        throw new Error(`Overall avg_ndcg ${result.overall_avg_ndcg.toFixed(6)} is below required ${minOverall}`);
    }
    if (minPrimary !== null && result.primary_avg_ndcg < minPrimary) {
        throw new Error(`Primary avg_ndcg ${result.primary_avg_ndcg.toFixed(6)} is below required ${minPrimary}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    DEFAULT_PRIMARY_TYPES,
    parseArgs,
    parseList
} = require('./lib.js');
const {
    EMBEDDING_PRESETS,
    generateVariantEmbeddings,
    getVariantEnv,
    resolveVariants,
    variantExists
} = require('./embedding-lib.js');

const REPO_ROOT = path.join(__dirname, '..');
const EVALUATE_SCRIPT = path.join(__dirname, 'evaluate-variant.js');

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

function outputPathFor(value) {
    return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

function summarizeVariantReport(report) {
    return {
        id: report.variant.id,
        label: report.variant.label,
        file: report.variant.embedding_file,
        model: report.variant.configured_embedding_model,
        auto_holdout_semantic_routed_avg_ndcg: report.headline.auto_holdout_semantic_routed_avg_ndcg,
        auto_holdout_overall_avg_ndcg: report.headline.auto_holdout_overall_avg_ndcg,
        semantic_holdout_semantic_routed_avg_ndcg: report.headline.semantic_holdout_semantic_routed_avg_ndcg,
        auto_full_semantic_routed_avg_ndcg: report.headline.auto_full_semantic_routed_avg_ndcg,
        semantic_cold_avg_ms: report.headline.semantic_cold_avg_ms,
        auto_cold_avg_ms: report.headline.auto_cold_avg_ms,
        hybrid_cold_avg_ms: report.headline.hybrid_cold_avg_ms
    };
}

function compareVariantSummaries(a, b) {
    return (
        (b.auto_holdout_semantic_routed_avg_ndcg ?? -Infinity) - (a.auto_holdout_semantic_routed_avg_ndcg ?? -Infinity) ||
        (b.auto_holdout_overall_avg_ndcg ?? -Infinity) - (a.auto_holdout_overall_avg_ndcg ?? -Infinity) ||
        (b.semantic_holdout_semantic_routed_avg_ndcg ?? -Infinity) - (a.semantic_holdout_semantic_routed_avg_ndcg ?? -Infinity) ||
        (a.semantic_cold_avg_ms ?? Infinity) - (b.semantic_cold_avg_ms ?? Infinity) ||
        a.id.localeCompare(b.id)
    );
}

function runVariantEvaluation(variant, {
    modes,
    latencyModes,
    primaryTypes,
    holdoutRatio,
    seed,
    latencyPerType,
    warmup,
    includePerQuery,
    verbose
}) {
    const args = [
        EVALUATE_SCRIPT,
        '--variant-id', variant.id,
        '--variant-label', variant.label,
        '--modes', modes.join(','),
        '--latency-modes', latencyModes.join(','),
        '--primary', primaryTypes.join(','),
        '--holdout-ratio', String(holdoutRatio),
        '--seed', String(seed),
        '--latency-per-type', String(latencyPerType),
        '--warmup', String(warmup)
    ];

    if (includePerQuery) args.push('--include-per-query');
    if (verbose) args.push('--verbose');

    const result = spawnSync(process.execPath, args, {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            ...getVariantEnv(variant),
            BAKEOFF_VARIANT_ID: variant.id,
            BAKEOFF_VARIANT_LABEL: variant.label
        },
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
    });

    if (result.status !== 0) {
        const error = new Error(`Variant evaluation failed for ${variant.id}`);
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        throw error;
    }

    return {
        report: JSON.parse(result.stdout.trim()),
        stderr: result.stderr.trim()
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const variants = parseList(args.variants, null);
    const preset = args.preset || 'quick';
    const includeCurrent = !Boolean(args['no-current']);
    const forceGenerate = Boolean(args['force-generate']);
    const skipGenerate = Boolean(args['skip-generate']);
    const modes = parseList(args.modes, ['auto', 'semantic', 'hybrid']);
    const latencyModes = parseList(args['latency-modes'], ['semantic', 'auto', 'hybrid']);
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const holdoutRatio = Number(args['holdout-ratio'] || 0.25);
    const seed = String(args.seed || 'holdout-v1');
    const latencyPerType = Number(args['latency-per-type'] || 1);
    const warmup = Number(args.warmup || 1);
    const includePerQuery = Boolean(args['include-per-query']);
    const verbose = Boolean(args.verbose);
    const output = args.output ? outputPathFor(args.output) : null;

    if (!variants && !EMBEDDING_PRESETS[preset]) {
        throw new Error(`Unknown preset "${preset}"`);
    }

    const resolvedVariants = resolveVariants({
        variants,
        preset,
        includeCurrent
    });

    const generationResults = [];
    for (const variant of resolvedVariants) {
        if (variant.type === 'current') {
            if (!variantExists(variant)) {
                throw new Error(`Current baseline embeddings file is missing: ${variant.filePath}`);
            }
            generationResults.push({ variant: variant.id, generated: false, skipped: true, file: variant.relativeFilePath });
            continue;
        }

        if (skipGenerate && !variantExists(variant)) {
            throw new Error(`Missing generated embeddings for ${variant.id}. Run benchmark/generate-embeddings.js first or omit --skip-generate.`);
        }

        const result = await generateVariantEmbeddings(variant, {
            force: forceGenerate,
            log: message => console.error(message),
            onProgress: ({ completed, total, elapsedMs }) => {
                if (completed === total || completed % 100 === 0) {
                    console.error(`  ${variant.id}: ${completed}/${total} (${Math.round((completed / total) * 100)}%) — ${(elapsedMs / 1000).toFixed(1)}s`);
                }
            }
        });
        generationResults.push({
            variant: variant.id,
            generated: result.generated,
            skipped: result.skipped,
            file: variant.relativeFilePath,
            durationMs: result.durationMs || 0
        });
    }

    const reports = [];
    const summaries = [];

    for (const variant of resolvedVariants) {
        console.error(`\n=== Evaluating ${variant.id} ===`);
        const { report, stderr } = runVariantEvaluation(variant, {
            modes,
            latencyModes,
            primaryTypes,
            holdoutRatio,
            seed,
            latencyPerType,
            warmup,
            includePerQuery,
            verbose
        });

        if (stderr) {
            console.error(stderr);
        }

        reports.push(report);
        summaries.push(summarizeVariantReport(report));
    }

    const rankedSummaries = [...summaries].sort(compareVariantSummaries);
    const summary = {
        benchmark: 'embedding-bakeoff',
        preset: variants ? null : preset,
        requested_variants: variants || null,
        generated: generationResults,
        ranking: {
            by_auto_holdout_semantic_routed: rankedSummaries.map(item => item.id)
        },
        variants: reports,
        variant_summaries: rankedSummaries,
        config: {
            modes,
            latency_modes: latencyModes,
            primary_types: primaryTypes,
            holdout_ratio: holdoutRatio,
            seed,
            latency_per_type: latencyPerType,
            warmup
        },
        timestamp: new Date().toISOString()
    };

    if (output) {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(summary, null, 2));
    }

    console.log(JSON.stringify(summary));

    console.error('\nEmbedding bakeoff ranking (higher is better, latency lower is better):');
    console.error(`${pad('variant', 28)} ${pad('holdout_auto_sem', 18)} ${pad('holdout_auto_all', 18)} ${pad('holdout_sem_sem', 18)} ${pad('semantic_cold_ms', 18)} ${pad('auto_cold_ms', 14)}`);
    rankedSummaries.forEach(item => {
        console.error(`${pad(item.id, 28)} ${pad((item.auto_holdout_semantic_routed_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.auto_holdout_overall_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.semantic_holdout_semantic_routed_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.semantic_cold_avg_ms ?? 0).toFixed(2), 18)} ${pad((item.auto_cold_avg_ms ?? 0).toFixed(2), 14)}`);
    });

    if (output) {
        console.error(`\nSaved full bakeoff report to ${output}`);
    }
}

main().catch(error => {
    console.error(error.message || error);
    if (error.stderr) {
        console.error(error.stderr);
    }
    process.exit(1);
});

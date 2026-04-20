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
    DEFAULT_WEIGHT_PROFILES,
    resolveWeightProfiles
} = require('./weight-profiles.js');

const REPO_ROOT = path.join(__dirname, '..');
const EVALUATE_SCRIPT = path.join(__dirname, 'evaluate-variant.js');

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

function outputPathFor(value) {
    return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

function summarizeProfileReport(report, profile) {
    return {
        id: profile.id,
        label: profile.label,
        search_config_override: profile.override,
        auto_holdout_semantic_routed_avg_ndcg: report.headline.auto_holdout_semantic_routed_avg_ndcg,
        auto_holdout_overall_avg_ndcg: report.headline.auto_holdout_overall_avg_ndcg,
        semantic_holdout_semantic_routed_avg_ndcg: report.headline.semantic_holdout_semantic_routed_avg_ndcg,
        auto_full_semantic_routed_avg_ndcg: report.headline.auto_full_semantic_routed_avg_ndcg,
        semantic_cold_avg_ms: report.headline.semantic_cold_avg_ms,
        auto_cold_avg_ms: report.headline.auto_cold_avg_ms
    };
}

function compareProfileSummaries(a, b) {
    return (
        (b.auto_holdout_semantic_routed_avg_ndcg ?? -Infinity) - (a.auto_holdout_semantic_routed_avg_ndcg ?? -Infinity) ||
        (b.auto_holdout_overall_avg_ndcg ?? -Infinity) - (a.auto_holdout_overall_avg_ndcg ?? -Infinity) ||
        (b.semantic_holdout_semantic_routed_avg_ndcg ?? -Infinity) - (a.semantic_holdout_semantic_routed_avg_ndcg ?? -Infinity) ||
        (a.semantic_cold_avg_ms ?? Infinity) - (b.semantic_cold_avg_ms ?? Infinity) ||
        a.id.localeCompare(b.id)
    );
}

function runProfileEvaluation(profile, {
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
        '--variant-id', `weights__${profile.id}`,
        '--variant-label', profile.label,
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

    const env = {
        ...process.env,
        QUIET_LOGS: '1'
    };

    if (profile.override) {
        env.SEARCH_CONFIG_OVERRIDE_JSON = JSON.stringify(profile.override);
    }

    const result = spawnSync(process.execPath, args, {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
    });

    if (result.status !== 0) {
        const error = new Error(`Weight profile evaluation failed for ${profile.id}`);
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
    const profileIds = parseList(args.profiles, DEFAULT_WEIGHT_PROFILES);
    const profiles = resolveWeightProfiles(profileIds);
    const modes = parseList(args.modes, ['auto', 'semantic', 'hybrid']);
    const latencyModes = parseList(args['latency-modes'], ['semantic', 'auto']);
    const primaryTypes = parseList(args.primary, DEFAULT_PRIMARY_TYPES);
    const holdoutRatio = Number(args['holdout-ratio'] || 0.25);
    const seed = String(args.seed || 'holdout-v1');
    const latencyPerType = Number(args['latency-per-type'] || 1);
    const warmup = Number(args.warmup || 1);
    const includePerQuery = Boolean(args['include-per-query']);
    const verbose = Boolean(args.verbose);
    const output = args.output ? outputPathFor(args.output) : null;

    const reports = [];
    const summaries = [];

    for (const profile of profiles) {
        console.error(`\n=== Evaluating weight profile ${profile.id} ===`);
        const { report, stderr } = runProfileEvaluation(profile, {
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

        reports.push({ profile, report });
        summaries.push(summarizeProfileReport(report, profile));
    }

    const rankedSummaries = [...summaries].sort(compareProfileSummaries);
    const summary = {
        benchmark: 'weight-bakeoff',
        profiles: reports.map(({ profile, report }) => ({
            id: profile.id,
            label: profile.label,
            override: profile.override,
            report
        })),
        ranking: {
            by_auto_holdout_semantic_routed: rankedSummaries.map(item => item.id)
        },
        profile_summaries: rankedSummaries,
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

    console.error('\nWeight profile ranking (higher is better, latency lower is better):');
    console.error(`${pad('profile', 24)} ${pad('holdout_auto_sem', 18)} ${pad('holdout_auto_all', 18)} ${pad('holdout_sem_sem', 18)} ${pad('semantic_cold_ms', 18)} ${pad('auto_cold_ms', 14)}`);
    rankedSummaries.forEach(item => {
        console.error(`${pad(item.id, 24)} ${pad((item.auto_holdout_semantic_routed_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.auto_holdout_overall_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.semantic_holdout_semantic_routed_avg_ndcg ?? 0).toFixed(4), 18)} ${pad((item.semantic_cold_avg_ms ?? 0).toFixed(2), 18)} ${pad((item.auto_cold_avg_ms ?? 0).toFixed(2), 14)}`);
    });

    if (output) {
        console.error(`\nSaved full weight bakeoff report to ${output}`);
    }
}

main().catch(error => {
    console.error(error.message || error);
    if (error.stderr) {
        console.error(error.stderr);
    }
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const { startServer } = require('../api-server.js');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_PRIMARY_TYPES = ['english_meaning', 'thematic'];
const DEFAULT_SEMANTIC_ROUTED_TYPES = ['english_meaning', 'thematic', 'literal'];
const DEFAULT_MODES = ['auto', 'semantic', 'hybrid', 'keyword'];

function loadTestSet() {
    return JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'evaluation', 'datasets', 'relevance.json'), 'utf8')
    );
}

function isLabeledTestCase(testCase) {
    return Array.isArray(testCase.expected) && testCase.expected.length > 0;
}

function stableTestCaseKey(testCase) {
    const expectedKey = (testCase.expected || [])
        .map(entry => `${entry.chengyu}:${entry.relevance}`)
        .join('|');
    return `${testCase.type}::${testCase.query}::${expectedKey}`;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function sortDeterministically(items, seed, type) {
    return [...items]
        .sort((a, b) => stableTestCaseKey(a).localeCompare(stableTestCaseKey(b)))
        .map(item => ({
            item,
            hash: hashString(`${seed}::${type}::${stableTestCaseKey(item)}`)
        }))
        .sort((a, b) => a.hash - b.hash || stableTestCaseKey(a.item).localeCompare(stableTestCaseKey(b.item)))
        .map(entry => entry.item);
}

function splitHoldoutTestSet(testSet, {
    holdoutRatio = 0.25,
    seed = 'holdout-v1'
} = {}) {
    const ratio = Number(holdoutRatio);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new Error('holdoutRatio must be between 0 and 1');
    }

    const labeledTestSet = testSet.filter(isLabeledTestCase);
    const grouped = {};
    for (const testCase of labeledTestSet) {
        if (!grouped[testCase.type]) grouped[testCase.type] = [];
        grouped[testCase.type].push(testCase);
    }

    const allocations = Object.entries(grouped)
        .sort(([typeA], [typeB]) => typeA.localeCompare(typeB))
        .map(([type, items]) => {
            const orderedItems = sortDeterministically(items, seed, type);
            const size = orderedItems.length;
            const maxHoldout = ratio >= 1 ? size : Math.max(0, size - 1);
            return {
                type,
                items: orderedItems,
                size,
                ideal: size * ratio,
                maxHoldout,
                holdoutCount: Math.min(Math.floor(size * ratio), maxHoldout)
            };
        });

    const maxTotalHoldout = allocations.reduce((sum, group) => sum + group.maxHoldout, 0);
    const targetHoldout = Math.min(Math.round(labeledTestSet.length * ratio), maxTotalHoldout);

    let allocatedHoldout = allocations.reduce((sum, group) => sum + group.holdoutCount, 0);
    while (allocatedHoldout < targetHoldout) {
        const candidate = allocations
            .filter(group => group.holdoutCount < group.maxHoldout)
            .sort((a, b) => {
                const remainderDiff = (b.ideal - b.holdoutCount) - (a.ideal - a.holdoutCount);
                if (remainderDiff !== 0) return remainderDiff;
                if (b.size !== a.size) return b.size - a.size;
                return a.type.localeCompare(b.type);
            })[0];

        if (!candidate) break;
        candidate.holdoutCount += 1;
        allocatedHoldout += 1;
    }

    const holdoutKeys = new Set(
        allocations.flatMap(group => group.items.slice(0, group.holdoutCount).map(stableTestCaseKey))
    );

    const developmentSet = [];
    const holdoutSet = [];
    for (const testCase of labeledTestSet) {
        if (holdoutKeys.has(stableTestCaseKey(testCase))) {
            holdoutSet.push(testCase);
        } else {
            developmentSet.push(testCase);
        }
    }

    const byType = {};
    allocations.forEach(group => {
        byType[group.type] = {
            total: group.size,
            development: group.size - group.holdoutCount,
            holdout: group.holdoutCount
        };
    });

    return {
        developmentSet,
        holdoutSet,
        summary: {
            seed: String(seed),
            holdout_ratio: ratio,
            total_query_count: labeledTestSet.length,
            development_query_count: developmentSet.length,
            holdout_query_count: holdoutSet.length,
            by_type: byType
        }
    };
}

function dcg(relevances, k) {
    let score = 0;
    for (let i = 0; i < Math.min(relevances.length, k); i++) {
        score += relevances[i] / Math.log2(i + 2);
    }
    return score;
}

function ndcg(actualResults, expectedResults, k = 5) {
    const relMap = new Map(expectedResults.map(entry => [entry.chengyu, entry.relevance]));
    const actualRels = actualResults.slice(0, k).map(result => relMap.get(result.chengyu) || 0);
    const idealRels = expectedResults
        .map(entry => entry.relevance)
        .sort((a, b) => b - a)
        .slice(0, k);

    const actualDCG = dcg(actualRels, k);
    const idealDCG = dcg(idealRels, k);
    if (idealDCG === 0) return 0;
    return actualDCG / idealDCG;
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 6) {
    return Number(value.toFixed(digits));
}

function summarizeScores(
    perQuery,
    primaryTypes = DEFAULT_PRIMARY_TYPES,
    semanticRoutedTypes = DEFAULT_SEMANTIC_ROUTED_TYPES
) {
    const primarySet = new Set(primaryTypes);
    const semanticRoutedSet = new Set(semanticRoutedTypes);
    const primaryScores = [];
    const semanticRoutedScores = [];
    const overallScores = [];
    const byType = {};

    perQuery.forEach(item => {
        overallScores.push(item.ndcg);
        if (!byType[item.type]) byType[item.type] = [];
        byType[item.type].push(item.ndcg);
        if (primarySet.has(item.type)) {
            primaryScores.push(item.ndcg);
        }
        if (semanticRoutedSet.has(item.type)) {
            semanticRoutedScores.push(item.ndcg);
        }
    });

    const typeScores = {};
    Object.entries(byType).forEach(([type, scores]) => {
        typeScores[type] = round(average(scores), 4);
    });

    const primaryAvg = average(primaryScores);
    const semanticRoutedAvg = average(semanticRoutedScores);
    const overallAvg = average(overallScores);

    return {
        avg_ndcg: round(primaryAvg),
        primary_avg_ndcg: round(primaryAvg),
        overall_avg_ndcg: round(overallAvg),
        semantic_routed_types: [...semanticRoutedTypes],
        semantic_routed_avg_ndcg: round(semanticRoutedAvg),
        semantic_routed_query_count: semanticRoutedScores.length,
        primary_query_count: primaryScores.length,
        total_query_count: overallScores.length,
        by_type: typeScores
    };
}

function resolveEndpoint(mode = 'auto') {
    return mode === 'auto' ? '/api/search' : `/api/search/${mode}`;
}

async function requestSearch(baseUrl, query, mode = 'auto', options = {}) {
    const response = await fetch(`${baseUrl}${resolveEndpoint(mode)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        body: JSON.stringify({ query })
    });

    const data = await response.json();
    if (!response.ok) {
        const error = new Error(data.error || `Request failed with status ${response.status}`);
        error.statusCode = response.status;
        error.payload = data;
        throw error;
    }

    return data;
}

async function benchmarkMode({
    baseUrl,
    testSet = loadTestSet(),
    mode = 'auto',
    primaryTypes = DEFAULT_PRIMARY_TYPES,
    semanticRoutedTypes = DEFAULT_SEMANTIC_ROUTED_TYPES,
    verbose = false,
    includePerQuery = false
}) {
    const perQuery = [];
    const errors = [];

    for (const testCase of testSet) {
        if (!testCase.expected.length) continue;

        try {
            const result = await requestSearch(baseUrl, testCase.query, mode);
            const rankedResults = (result.results || []).map(item => ({ chengyu: item.chengyu }));
            const score = ndcg(rankedResults, testCase.expected, 5);

            if (verbose) {
                const top3 = rankedResults.slice(0, 3).map(item => item.chengyu).join(', ');
                console.error(`  [${mode}] ${testCase.query}: NDCG@5=${score.toFixed(4)} → [${top3}]`);
            }

            perQuery.push({
                query: testCase.query,
                type: testCase.type,
                ndcg: score,
                mode,
                endpoint_mode: result.mode,
                query_type: result.queryType || null,
                auto_routed: Boolean(result.autoRouted),
                fallback_from: result.fallbackFrom || null,
                actual_top_results: rankedResults.slice(0, 5).map(item => item.chengyu),
                expected_top_results: testCase.expected
                    .slice()
                    .sort((a, b) => b.relevance - a.relevance)
                    .slice(0, 5)
                    .map(item => ({
                        chengyu: item.chengyu,
                        relevance: item.relevance
                    }))
            });
        } catch (error) {
            errors.push({ query: testCase.query, type: testCase.type, message: error.message });
            console.error(`  ERROR [${mode}] ${testCase.query}: ${error.message}`);
        }
    }

    return {
        mode,
        endpoint: resolveEndpoint(mode),
        primary_types: [...primaryTypes],
        semantic_routed_types: [...semanticRoutedTypes],
        errors,
        ...(includePerQuery ? { per_query: perQuery } : {}),
        ...summarizeScores(perQuery, primaryTypes, semanticRoutedTypes),
        timestamp: new Date().toISOString()
    };
}

function percentile(values, pct) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
    return sorted[Math.max(index, 0)];
}

function summarizeLatencySamples(samples) {
    const durations = samples.map(sample => sample.duration_ms);
    return {
        sample_count: samples.length,
        avg_ms: round(average(durations), 3),
        p50_ms: round(percentile(durations, 50), 3),
        p95_ms: round(percentile(durations, 95), 3),
        min_ms: round(Math.min(...durations), 3),
        max_ms: round(Math.max(...durations), 3)
    };
}

function stratifiedSample(testSet, perType = 2) {
    const grouped = {};
    for (const testCase of testSet) {
        if (!isLabeledTestCase(testCase)) continue;
        if (!grouped[testCase.type]) grouped[testCase.type] = [];
        grouped[testCase.type].push(testCase);
    }

    return Object.values(grouped)
        .flatMap(group => group.slice(0, perType))
        .map(testCase => ({ query: testCase.query, type: testCase.type }));
}

async function benchmarkLatencyMode({
    baseUrl,
    mode = 'auto',
    queries,
    warmup = 1,
    verbose = false
}) {
    const coldSamples = [];
    const warmSamples = [];

    for (const entry of queries) {
        const coldStart = process.hrtime.bigint();
        await requestSearch(baseUrl, entry.query, mode, {
            headers: {
                'x-benchmark-bypass-cache': '1',
                'x-benchmark-bypass-embedding-cache': '1'
            }
        });
        const coldDurationMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
        coldSamples.push({
            mode,
            query: entry.query,
            type: entry.type,
            duration_ms: coldDurationMs,
            temperature: 'cold'
        });

        for (let i = 0; i < warmup; i++) {
            await requestSearch(baseUrl, entry.query, mode);
        }

        const warmStart = process.hrtime.bigint();
        await requestSearch(baseUrl, entry.query, mode);
        const warmDurationMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
        warmSamples.push({
            mode,
            query: entry.query,
            type: entry.type,
            duration_ms: warmDurationMs,
            temperature: 'warm'
        });

        if (verbose) {
            console.error(`  [${mode}] ${entry.type} · ${entry.query} → cold ${coldDurationMs.toFixed(2)}ms, warm ${warmDurationMs.toFixed(2)}ms`);
        }
    }

    function summarizeByType(samples) {
        const byType = {};
        for (const sample of samples) {
            if (!byType[sample.type]) byType[sample.type] = [];
            byType[sample.type].push(sample);
        }

        const summary = {};
        Object.entries(byType).forEach(([type, typeSamples]) => {
            summary[type] = summarizeLatencySamples(typeSamples);
        });
        return summary;
    }

    return {
        mode,
        endpoint: resolveEndpoint(mode),
        warmup_count: warmup,
        query_count: queries.length,
        cold: {
            by_type: summarizeByType(coldSamples),
            ...summarizeLatencySamples(coldSamples)
        },
        warm: {
            by_type: summarizeByType(warmSamples),
            ...summarizeLatencySamples(warmSamples)
        },
        timestamp: new Date().toISOString()
    };
}

async function startBenchmarkServer({ useExisting = false, port = 3000 } = {}) {
    if (useExisting) {
        return {
            baseUrl: `http://127.0.0.1:${port}`,
            close: async () => {}
        };
    }

    const server = await startServer({ port: port || 0 });
    const actualPort = server.address().port;

    return {
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: async () => {
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    };
}

function parseArgs(argv) {
    const args = {};

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;

        const eqIndex = token.indexOf('=');
        if (eqIndex !== -1) {
            const key = token.slice(2, eqIndex);
            const value = token.slice(eqIndex + 1);
            args[key] = value;
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }

    return args;
}

function parseList(value, fallback) {
    if (!value) return fallback;
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function outputPathFor(value) {
    return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

function formatOutputTimestamp(date = new Date()) {
    return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

function getBenchmarkOutputPath(args, benchmarkName, descriptor = '') {
    if (args.output) {
        return outputPathFor(String(args.output));
    }

    if (!args.save && !args['output-dir']) {
        return null;
    }

    const outputDir = outputPathFor(String(args['output-dir'] || 'benchmark/results'));
    const parts = [benchmarkName, descriptor].filter(Boolean);
    const fileName = `${parts.join('-')}-${formatOutputTimestamp()}.json`;
    return path.join(outputDir, fileName);
}

function writeJsonArtifact(outputPath, payload) {
    if (!outputPath) return null;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    return outputPath;
}

async function suppressConsoleLog(fn) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.log = originalLog;
    }
}

module.exports = {
    DEFAULT_MODES,
    DEFAULT_PRIMARY_TYPES,
    DEFAULT_SEMANTIC_ROUTED_TYPES,
    benchmarkLatencyMode,
    benchmarkMode,
    getBenchmarkOutputPath,
    loadTestSet,
    ndcg,
    outputPathFor,
    parseArgs,
    parseList,
    requestSearch,
    resolveEndpoint,
    splitHoldoutTestSet,
    startBenchmarkServer,
    stratifiedSample,
    suppressConsoleLog,
    summarizeLatencySamples,
    summarizeScores,
    writeJsonArtifact
};

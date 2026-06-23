#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const {
    isBinaryEmbeddingPath,
    readBinaryEmbeddingArtifact
} = require('../src/embeddings/embedding-binary.js');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_EMBEDDINGS_FILE = path.join(REPO_ROOT, 'embeddings-local.bin');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
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

function loadArtifact(filePath) {
    const data = fs.readFileSync(filePath);
    return isBinaryEmbeddingPath(filePath)
        ? readBinaryEmbeddingArtifact(data)
        : JSON.parse(data.toString('utf8'));
}

function dotProduct(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

function scanTopK(query, vectors, topK) {
    const best = [];
    for (let i = 0; i < vectors.length; i++) {
        const score = dotProduct(query, vectors[i]);
        if (best.length < topK) {
            best.push({ index: i, score });
            best.sort((a, b) => a.score - b.score);
            continue;
        }
        if (score > best[0].score) {
            best[0] = { index: i, score };
            best.sort((a, b) => a.score - b.score);
        }
    }
    return best.sort((a, b) => b.score - a.score);
}

function percentile(values, pct) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
    return sorted[index] || 0;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const filePath = path.resolve(args.file || process.env.EMBEDDINGS_FILE || DEFAULT_EMBEDDINGS_FILE);
    const iterations = Number(args.iterations || 100);
    const topK = Number(args.topK || 10);
    const artifact = loadArtifact(filePath);
    const vectors = artifact.embeddings.map(entry => Float32Array.from(entry.embedding));
    const queries = vectors.slice(0, Math.min(iterations, vectors.length));

    // Warm up JIT and caches.
    scanTopK(queries[0], vectors, topK);

    const timings = [];
    for (let i = 0; i < iterations; i++) {
        const query = queries[i % queries.length];
        const start = performance.now();
        scanTopK(query, vectors, topK);
        timings.push(performance.now() - start);
    }

    const avg = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    const summary = {
        benchmark: 'vector-scan',
        file: path.relative(REPO_ROOT, filePath),
        corpus_size: vectors.length,
        dimensions: artifact.dimensions,
        iterations,
        topK,
        avg_ms: Number(avg.toFixed(4)),
        p50_ms: Number(percentile(timings, 50).toFixed(4)),
        p95_ms: Number(percentile(timings, 95).toFixed(4)),
        max_ms: Number(Math.max(...timings).toFixed(4)),
        timestamp: new Date().toISOString()
    };

    console.log(JSON.stringify(summary));
    console.error(`Scanned ${summary.corpus_size} vectors x ${summary.dimensions} dims for top-${topK}`);
    console.error(`avg=${summary.avg_ms}ms p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms`);
}

main();

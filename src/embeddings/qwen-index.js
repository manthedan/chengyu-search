'use strict';
const fs = require('node:fs');
const { MODEL, DIMENSIONS, TEMPLATE, RECIPE_HASH, sha, unitVector } = require('./hosted-recipe');
const { validateEmbeddingArtifact, buildEmbeddingCorpusHash } = require('./embedding-validation');
const MAGIC = Buffer.from('CHENGYU_QWEN_I8_V1\n');
const STRIDE = DIMENSIONS + 4;

function writeQwenIndex(database, vectors, provenance) {
    if (database.length !== vectors.length || !database.length) throw Error('Qwen row count mismatch');
    const payload = Buffer.alloc(database.length * STRIDE);
    for (let row = 0; row < database.length; row++) {
        const vector = unitVector(vectors[row]), max = Math.max(...vector.map(Math.abs));
        let norm2 = 0;
        for (let j = 0; j < DIMENSIONS; j++) {
            const q = Math.max(-127, Math.min(127, Math.round(vector[j] / max * 127)));
            payload.writeInt8(q, row * STRIDE + 4 + j); norm2 += q * q;
        }
        payload.writeFloatLE(1 / Math.sqrt(norm2), row * STRIDE);
    }
    const metadata = { version: 1, format: 'qwen-row-unit-int8-v1', source: 'workers-ai-api', model: MODEL,
        template: TEMPLATE, pooling: 'last-token', normalize: true, dimensions: DIMENSIONS,
        recipeHash: RECIPE_HASH, corpusHash: buildEmbeddingCorpusHash(database, TEMPLATE),
        entryCount: database.length, generatedAt: new Date().toISOString(), ...provenance,
        entries: database.map(e => ({ id: e.id, chengyu: e.chengyu })), vectorHash: sha(payload) };
    const json = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(MAGIC.length + 4);
    MAGIC.copy(header); header.writeUInt32LE(json.length, MAGIC.length);
    return { buffer: Buffer.concat([header, json, payload]), metadata };
}

function readQwenIndex(buffer, database, { template = TEMPLATE, recipeHash = RECIPE_HASH, corpusDatabase = database } = {}) {
    if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('Invalid Qwen artifact header');
    const end = MAGIC.length + 4 + buffer.readUInt32LE(MAGIC.length);
    if (end > buffer.length) throw Error('Invalid Qwen metadata length');
    const metadata = JSON.parse(buffer.subarray(MAGIC.length + 4, end).toString('utf8'));
    const payload = buffer.subarray(end);
    if (metadata.format !== 'qwen-row-unit-int8-v1' || !Array.isArray(metadata.entries)
        || metadata.entries.length !== database.length || payload.length !== database.length * STRIDE
        || sha(payload) !== metadata.vectorHash) throw Error('Qwen payload integrity mismatch');
    // Ranking features are validated in corpus order. Require the same ID at
    // every vector position before positional scores or priors can be used.
    if (metadata.entries.some((entry, i) => entry?.id !== database[i].id)) {
        throw Error('Qwen vector row order does not match corpus IDs');
    }
    const norms = new Float32Array(database.length);
    const rows = metadata.entries.map((entry, i) => {
        norms[i] = payload.readFloatLE(i * STRIDE);
        const embedding = new Int8Array(payload.buffer, payload.byteOffset + i * STRIDE + 4, DIMENSIONS);
        let norm2 = 0;
        for (const value of embedding) norm2 += value * value;
        if (!Number.isFinite(norms[i]) || norms[i] <= 0 || Math.abs(norms[i] * Math.sqrt(norm2) - 1) > 1e-6) throw Error('Invalid Qwen row norm');
        return { ...entry, embedding };
    });
    const validation = validateEmbeddingArtifact({ ...metadata, embeddings: rows }, database, {
        expectedModel: MODEL, expectedTemplate: template, expectedPooling: 'last-token', expectedNormalize: true,
        expectedDimensions: DIMENSIONS, expectedRecipeHash: recipeHash,
        expectedCorpusHash: buildEmbeddingCorpusHash(corpusDatabase, template), allowLegacyIds: false
    });
    if (!validation.ok) throw Error('Qwen artifact validation failed: ' + validation.diagnostics.slice(0, 3).join('; '));
    const byId = new Map(database.map(e => [e.id, e]));
    return { metadata, rows, norms, byId };
}
function loadQwenIndex(file, database, options) { return readQwenIndex(fs.readFileSync(file), database, options); }
// `stats`, when given, receives the mean and standard deviation of every row's score, so callers can
// measure how far the top result stands out from the corpus without a second scan.
function scanQwen(index, query, limit = 20, adjustments = null, stats = null) {
    if (!Number.isInteger(limit) || limit < 1) throw Error('Invalid Qwen result limit');
    if (adjustments && (adjustments.length !== index.rows.length || !Array.from(adjustments).every(Number.isFinite))) throw Error('Invalid ranking prior adjustments');
    const vector = unitVector(query), top = [];
    let sum = 0, sumSquares = 0;
    for (let i = 0; i < index.rows.length; i++) {
        const values = index.rows[i].embedding;
        let dot = 0;
        for (let j = 0; j < DIMENSIONS; j++) dot += values[j] * vector[j];
        const score = dot * index.norms[i] + (adjustments ? adjustments[i] : 0);
        sum += score; sumSquares += score * score;
        if (top.length < limit || score > top.at(-1).score) {
            top.push({ row: i, score }); top.sort((a,b) => b.score - a.score || a.row - b.row);
            if (top.length > limit) top.pop();
        }
    }
    if (stats) {
        const n = index.rows.length, mean = n ? sum / n : 0;
        stats.mean = mean; stats.std = n ? Math.sqrt(Math.max(0, sumSquares / n - mean * mean)) : 0;
    }
    return top.map(({ row, score }) => {
        const entry = index.rows[row], item = index.byId.get(entry.id);
        return { id: entry.id, chengyu: entry.chengyu, item, score };
    });
}
module.exports = { writeQwenIndex, readQwenIndex, loadQwenIndex, scanQwen };

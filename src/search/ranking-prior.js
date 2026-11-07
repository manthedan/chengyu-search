'use strict';
const fs = require('node:fs');
const { sha } = require('../embeddings/hosted-recipe');
const { buildEmbeddingCorpusHash } = require('../embeddings/embedding-validation');
const CLASSES = ['chengyu', 'set_phrase', 'official_political', 'technical_or_proper'];
const WEIGHTS = ['vividness', 'frequency', 'xinhua', 'set_phrase'];
function validateWeights(weights) {
    if (!weights || Object.keys(weights).sort().join() !== [...WEIGHTS].sort().join()
        || WEIGHTS.some(k => !Number.isFinite(weights[k]) || weights[k] < 0)
        || weights.vividness > .03 || weights.frequency > .01 || weights.xinhua > .005 || weights.set_phrase > .015) throw Error('Invalid ranking prior weights');
}
function buildPrior(database, artifact, weights = artifact.weights) {
    validateWeights(weights);
    if (artifact.version !== 1 || artifact.baseCorpusHash !== buildEmbeddingCorpusHash(database, 'qwen-bilingual-v1')
        || !Array.isArray(artifact.entries) || artifact.entries.length !== database.length
        || artifact.entriesHash !== sha(JSON.stringify(artifact.entries))) throw Error('Ranking prior corpus integrity mismatch');
    const max = Math.max(1, ...artifact.entries.map(r => r[3]));
    const adjustments = new Float32Array(database.length), seen = new Set();
    artifact.entries.forEach((row, i) => {
        if (!Array.isArray(row) || row.length !== 5 || row[0] !== database[i].id || seen.has(row[0])
            || !CLASSES.includes(row[1]) || row[1] !== (database[i].kind || 'chengyu')
            || ![1, 2, 3].includes(row[2]) || !Number.isFinite(row[3]) || row[3] < 0
            || ![0, 1].includes(row[4])) throw Error('Invalid ranking prior row');
        seen.add(row[0]);
        adjustments[i] = weights.vividness * (row[2] - 1) / 2
            + weights.frequency * Math.log1p(row[3]) / Math.log1p(max)
            + weights.xinhua * row[4] - weights.set_phrase * Number(row[1] !== 'chengyu');
    });
    return { adjustments, weights, entriesHash: artifact.entriesHash, rows: adjustments.length };
}
function loadRankingPrior(file, database, template = 'qwen-bilingual-v1') {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateWeights(artifact.weights);
    validateWeights(artifact.situationWeights);
    return buildPrior(database, artifact, template === 'qwen-bilingual-situations-v1' ? artifact.situationWeights : artifact.weights);
}
function configuredPrior(env = process.env) {
    const setting = env.RANKING_PRIOR || 'off';
    if (!['on', 'off'].includes(setting)) throw Error('RANKING_PRIOR must be on or off');
    return setting === 'on';
}
module.exports = { buildPrior, loadRankingPrior, validateWeights, configuredPrior };

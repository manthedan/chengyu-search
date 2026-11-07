'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, hasHan } = require('../data/chinese-normalizer/normalize');

const MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const DIMENSIONS = 1024;
const TEMPLATE = 'qwen-bilingual-v1';
const INSTRUCTION = 'Given a description of a situation, retrieve Chinese idioms whose meanings fit the situation.';
/** @param {string | Buffer} value */
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Bind both directions of the recipe to the compact serving normalizer. A
// normalizer/code change requires rebuilding the artifact, even if texts agree.
const RECIPE = {
    version: 1, model: MODEL, template: TEMPLATE, instruction: INSTRUCTION,
    query: 'Instruct: <instruction>\nQuery: <Han: compact normalize; otherwise trim>',
    document: '<chengyu>. Meaning: <meaning>. Literal: <literal>. Topics: <tags joined comma-space>\n释义：<normalize(trim(meaning_zh) || example before （/( || chengyu)>',
    normalizer: Object.fromEntries(['normalize.js', 'compact-table.js', 'normalizer-data.bin'].map(file => [file,
        sha(fs.readFileSync(path.join(__dirname, '../data/chinese-normalizer', file)))]))
};
const RECIPE_HASH = sha(JSON.stringify(RECIPE));
/** @param {import('./embedding-validation').TemplateEntry} entry */
function documentText(entry) {
    const zh = normalize(entry.meaning_zh?.trim() || entry.example?.split(/[（(]/)[0] || entry.chengyu || '');
    return `${entry.chengyu}. Meaning: ${entry.meaning || ''}. Literal: ${entry.literal || ''}. Topics: ${(entry.tags || []).join(', ')}\n释义：${zh}`;
}
/** @param {string} query */
function queryText(query) {
    const text = hasHan(query) ? normalize(query) : query.trim();
    return `Instruct: ${INSTRUCTION}\nQuery: ${text}`;
}
/** @param {string} text */
function vectorKey(text) { return sha(JSON.stringify([MODEL, text])); }
/** @param {string} text */
function queryKey(text) { return sha(JSON.stringify([MODEL, RECIPE_HASH, text])); }
/** @param {number[] | Float32Array} vector */
function unitVector(vector) {
    if (!Array.isArray(vector) && !(vector instanceof Float32Array)) throw Error('Invalid embedding vector');
    if (vector.length !== DIMENSIONS || !Array.from(vector).every(Number.isFinite)) throw Error('Invalid embedding vector');
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw Error('Invalid embedding vector');
    return Float32Array.from(vector, x => x / norm);
}
module.exports = { MODEL, DIMENSIONS, TEMPLATE, INSTRUCTION, RECIPE, RECIPE_HASH, sha, documentText, queryText, vectorKey, queryKey, unitVector };

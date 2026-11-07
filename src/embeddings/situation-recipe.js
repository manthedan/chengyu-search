'use strict';
const base = require('./hosted-recipe');
const TEMPLATE = 'qwen-bilingual-situations-v1';
const RECIPE = { ...base.RECIPE, template: TEMPLATE,
    document: base.RECIPE.document + '\n使用场景：<zh1>；<zh2>\nUsage situations: <en1> | <en2>' };
const RECIPE_HASH = base.sha(JSON.stringify(RECIPE));
/** @param {import('./embedding-validation').TemplateEntry} entry */
function documentText(entry) {
    const situations = entry.usage_situations;
    if (!Array.isArray(situations) || situations.length !== 4 || situations.some(s => typeof s !== 'string' || !s.trim())) throw Error('Four usage situations required');
    return base.documentText(entry) + `\n使用场景：${situations[0]}；${situations[1]}\nUsage situations: ${situations[2]} | ${situations[3]}`;
}
/**
 * @template {import('./embedding-validation').TemplateEntry & {id?: string}} T
 * @param {T[]} database
 * @param {{version?: number, entries?: any[], entriesHash?: string}} artifact
 * @returns {(T & {usage_situations: string[]})[]}
 */
function withSituations(database, artifact) {
    if (artifact.version !== 1 || !Array.isArray(artifact.entries) || artifact.entries.length !== database.length
        || artifact.entriesHash !== base.sha(JSON.stringify(artifact.entries))) throw Error('Invalid situations artifact');
    const entries = artifact.entries;
    const seen = new Set();
    return database.map((entry, i) => {
        const row = entries[i];
        if (!Array.isArray(row) || row.length !== 5 || row[0] !== entry.id || seen.has(row[0])) throw Error('Situations identity mismatch');
        seen.add(row[0]);
        const result = { ...entry, usage_situations: row.slice(1) };
        documentText(result);
        return result;
    });
}
module.exports = { TEMPLATE, RECIPE, RECIPE_HASH, documentText, withSituations };

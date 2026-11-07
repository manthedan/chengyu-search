'use strict';
// Idiom-variant grouping: several corpus entries can be forms of one idiom
// (盲人摸象 / 瞎子摸象, 塞翁失马 / 塞翁失马焉知非福). Searches keep only the
// best-ranked form of each family and every result lists its family.
//
// The alias map (data/variant-families.json) links headwords, i.e. the
// simplified form `simplified || chengyu`:
//   same       one idiom written two ways; transitive (union-find clusters)
//   full_form  a short form and the full saying containing it; links two
//              clusters and is never chained further
// Entries sharing one headword are distinct senses, never variants of each
// other, so collapsing never hides a second sense of the same headword.
const fs = require('node:fs');

const RELATIONS = new Set(['same', 'full_form']);
const COMMON_SIDES = new Set(['a', 'b', 'equal']);
const DEFAULT_GROWTH_CAP = 4;

const headwordOf = entry => entry.simplified || entry.chengyu;

/**
 * Throws on the first problem, so a bad map never half-applies.
 * @param {unknown} map
 * @param {ReadonlySet<string>} knownHeadwords
 */
function validateVariantMap(map, knownHeadwords) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('map must be an object');
    if (typeof map.version !== 'string' || !map.version.trim()) throw new Error('version must be a non-empty string');
    if (!Array.isArray(map.links)) throw new Error('links must be an array');
    const seen = new Set();
    map.links.forEach((link, i) => {
        const where = `links[${i}]`;
        if (!link || typeof link !== 'object') throw new Error(`${where} must be an object`);
        const { a, b, relation, common } = link;
        if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) throw new Error(`${where} needs headwords a and b`);
        if (a === b) throw new Error(`${where} links ${a} to itself`);
        if (!RELATIONS.has(relation)) throw new Error(`${where} has unknown relation ${JSON.stringify(relation)}`);
        if (!COMMON_SIDES.has(common)) throw new Error(`${where} has unknown common ${JSON.stringify(common)}`);
        for (const headword of [a, b]) {
            if (!knownHeadwords.has(headword)) throw new Error(`${where} names ${headword}, which is not a corpus headword`);
        }
        const key = [a, b].sort().join('\u0000');
        if (seen.has(key)) throw new Error(`${where} repeats the pair ${a} / ${b}`);
        seen.add(key);
    });
    if (map.headlines !== undefined) {
        if (!Array.isArray(map.headlines)) throw new Error('headlines must be an array');
        const fullForms = new Set();
        map.headlines.forEach((headline, i) => {
            const where = `headlines[${i}]`;
            if (!headline || typeof headline !== 'object') throw new Error(`${where} must be an object`);
            const { short, full } = headline;
            if (typeof short !== 'string' || typeof full !== 'string' || !short || !full || short === full) throw new Error(`${where} needs distinct headwords short and full`);
            for (const headword of [short, full]) {
                if (!knownHeadwords.has(headword)) throw new Error(`${where} names ${headword}, which is not a corpus headword`);
            }
            if (fullForms.has(full)) throw new Error(`${where} repeats the full saying ${full}`);
            fullForms.add(full);
        });
    }
}

/**
 * @param {{ version: string, links: Array<{ a: string, b: string, relation: string, common: string }> }} map
 * @param {ReadonlyArray<object>} database corpus entries with id/publicId
 */
function createVariantFamilies(map, database) {
    /** @type {Map<string, object[]>} */
    const entriesByHeadword = new Map();
    const headwordById = new Map();
    for (const entry of database) {
        const headword = headwordOf(entry);
        if (!entriesByHeadword.has(headword)) entriesByHeadword.set(headword, []);
        entriesByHeadword.get(headword).push(entry);
        if (entry.id) headwordById.set(entry.id, headword);
    }
    validateVariantMap(map, new Set(entriesByHeadword.keys()));

    // Union-find over `same` links only.
    const parent = new Map();
    const find = headword => {
        if (!parent.has(headword)) parent.set(headword, headword);
        while (parent.get(headword) !== headword) {
            parent.set(headword, parent.get(parent.get(headword)));
            headword = parent.get(headword);
        }
        return headword;
    };
    const ordered = [];
    for (const { a, b, relation } of map.links) {
        for (const headword of [a, b]) if (!parent.has(headword)) { find(headword); ordered.push(headword); }
        if (relation === 'same') parent.set(find(a), find(b));
    }
    const members = new Map();
    for (const headword of ordered) {
        const root = find(headword);
        if (!members.has(root)) members.set(root, []);
        members.get(root).push(headword);
    }
    // full_form links relate two whole clusters, one hop only.
    const linkedClusters = new Map(ordered.map(headword => [find(headword), new Set()]));
    for (const { a, b, relation } of map.links) {
        if (relation !== 'full_form' || find(a) === find(b)) continue;
        linkedClusters.get(find(a)).add(find(b));
        linkedClusters.get(find(b)).add(find(a));
    }

    /** @type {Map<string, Map<string, 'same' | 'full_form'>>} related headword -> relation, per headword */
    const relatedByHeadword = new Map();
    for (const headword of ordered) {
        const root = find(headword);
        const related = new Map();
        for (const other of members.get(root)) if (other !== headword) related.set(other, 'same');
        for (const cluster of linkedClusters.get(root)) {
            for (const other of members.get(cluster)) related.set(other, 'full_form');
        }
        if (related.size) relatedByHeadword.set(headword, related);
    }

    const NO_VARIANTS = Object.freeze([]);

    // The most common form of each `same` cluster: the member that wins the most
    // pairwise "common" votes (ties keep the earlier-listed member).
    const votes = new Map(ordered.map(headword => [headword, 0]));
    for (const { a, b, relation, common } of map.links) {
        if (relation !== 'same' || common === 'equal') continue;
        const [winner, loser] = common === 'a' ? [a, b] : [b, a];
        votes.set(winner, votes.get(winner) + 1);
        votes.set(loser, votes.get(loser) - 1);
    }
    const commonByRoot = new Map();
    for (const headword of ordered) {
        const root = find(headword);
        const current = commonByRoot.get(root);
        if (current === undefined || votes.get(headword) > votes.get(current)) commonByRoot.set(root, headword);
    }
    // Which form of a short form and its full saying should headline is a
    // per-idiom call (a blind test, experiments/variants-v1/shortform, found no
    // structural rule). The map's `headlines` list names each full saying that
    // shows as its short form; every other full_form link keeps the ranked form.
    const preferredByRoot = new Map([...members.keys()].map(root => [root, commonByRoot.get(root)]));
    for (const { short, full } of map.headlines || []) {
        if (!parent.has(short) || !parent.has(full) || !linkedClusters.get(find(full))?.has(find(short))) {
            throw new Error(`headline ${full} -> ${short} needs a full_form link between them`);
        }
        preferredByRoot.set(find(full), commonByRoot.get(find(short)));
    }
    const preferredHeadword = headword => (parent.has(headword) ? preferredByRoot.get(find(headword)) : headword);

    const variantsByHeadword = new Map();
    for (const [headword, related] of relatedByHeadword) {
        const variants = [];
        for (const [other, relation] of related) {
            for (const entry of entriesByHeadword.get(other)) {
                variants.push(Object.freeze({
                    simplified: headwordOf(entry),
                    traditional: entry.traditional || entry.chengyu,
                    pinyin: entry.pinyin,
                    publicId: entry.publicId || entry.id,
                    relation,
                    // The family's usual form, as a meaning search would show it.
                    preferred: other === preferredHeadword(headword),
                    // The usual spelling of its own cluster, so a page can list one
                    // short form or full saying without its rarer spellings.
                    common: other === commonByRoot.get(find(other))
                }));
            }
        }
        variantsByHeadword.set(headword, Object.freeze(variants));
    }
    const compact = text => String(text || '').normalize('NFKC').replace(/[\s，,。.、；;：:！!？?'"“”‘’·-]/g, '').toLowerCase();
    const tonelessPinyin = text => compact(String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[0-9]/g, '').replace(/ü|u:/g, 'v'));
    const typedExactly = (entry, query) => {
        const typed = compact(query);
        if (!typed) return false;
        return [entry.simplified, entry.traditional, entry.chengyu].some(form => form && compact(form) === typed)
            || (tonelessPinyin(entry.pinyin) !== '' && tonelessPinyin(entry.pinyin) === tonelessPinyin(query));
    };

    const resultHeadword = result => (result.item ? headwordOf(result.item) : headwordById.get(result.id) ?? result.chengyu);

    return {
        version: map.version,
        linkCount: map.links.length,
        /** @param {string} a @param {string} b */
        areRelated: (a, b) => a !== b && Boolean(relatedByHeadword.get(a)?.has(b)),
        /**
         * The entry to show for a kept result: its family's most common form,
         * or the short form its map headline names, unless the user typed this
         * form exactly (characters or pinyin).
         * @param {object} entry @param {string} [query] @returns {object}
         */
        displayEntry(entry, query = '') {
            const headword = entry && headwordOf(entry);
            if (!headword || !parent.has(headword) || typedExactly(entry, query)) return entry;
            const common = preferredHeadword(headword);
            if (common === headword) return entry;
            return entriesByHeadword.get(common)?.[0] || entry;
        },
        /** @param {object} entry @returns {ReadonlyArray<object>} */
        variantsOf: entry => (entry && variantsByHeadword.get(headwordOf(entry))) || NO_VARIANTS,
        /**
         * Walks a ranked list in order and drops a result when a result already
         * kept is related to it. Order and the kept objects are unchanged.
         * @template T
         * @param {ReadonlyArray<T>} rankedResults
         * @returns {T[]}
         */
        collapse(rankedResults) {
            const keptHeadwords = new Set();
            return rankedResults.filter(result => {
                const headword = resultHeadword(result);
                const related = relatedByHeadword.get(headword);
                if (related && [...related.keys()].some(other => keptHeadwords.has(other))) return false;
                keptHeadwords.add(headword);
                return true;
            });
        }
    };
}

/**
 * Asks the ranker for enough raw results to fill `needed` collapsed slots,
 * growing the raw window when collapsing removed results. Because collapse
 * only looks backwards, the collapsed list for a larger window extends the
 * one for a smaller window, so pages and totals stay consistent.
 * @template T
 * @param {ReturnType<typeof createVariantFamilies> | null} families
 * @param {number} needed
 * @param {(window: number) => T[] | Promise<T[]>} rank
 * @param {{ maxWindow?: number }} [options]
 * @returns {Promise<T[]>}
 */
async function rankCollapsed(families, needed, rank, { maxWindow = needed * DEFAULT_GROWTH_CAP } = {}) {
    if (!families) return rank(needed);
    let window = needed;
    for (;;) {
        const raw = await rank(window);
        const collapsed = families.collapse(raw);
        // Trimmed to `needed` so has-more flags match an ungrouped ranker's.
        if (collapsed.length >= needed || raw.length < window || window >= maxWindow) return collapsed.slice(0, needed);
        window = Math.min(maxWindow, window * 2);
    }
}

/** VARIANT_GROUPING=0 (or false/no/off) turns grouping off; it is on by default. */
function isVariantGroupingEnabled(env = process.env) {
    return !['0', 'false', 'no', 'off'].includes(String(env.VARIANT_GROUPING ?? '').trim().toLowerCase());
}

/**
 * Never throws: a disabled switch, missing file or invalid map all mean
 * grouping is off, with one log line saying why.
 * @returns {ReturnType<typeof createVariantFamilies> | null}
 */
function loadVariantFamilies({ filePath, database, env = process.env, logInfo = () => {}, logError = console.error }) {
    if (!isVariantGroupingEnabled(env)) {
        logInfo('Variant grouping: off (VARIANT_GROUPING=0)');
        return null;
    }
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        logInfo(`Variant grouping: off (no map at ${filePath})`);
        return null;
    }
    try {
        const families = createVariantFamilies(JSON.parse(text), database);
        logInfo(`Variant grouping: on (${families.version}, ${families.linkCount} links)`);
        return families;
    } catch (error) {
        logError(`Variant grouping: off (invalid map ${filePath}: ${error instanceof Error ? error.message : error})`);
        return null;
    }
}

module.exports = {
    createVariantFamilies,
    validateVariantMap,
    rankCollapsed,
    isVariantGroupingEnabled,
    loadVariantFamilies
};

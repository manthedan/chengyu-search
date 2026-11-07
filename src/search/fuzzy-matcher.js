'use strict';
// Exact for search-logic's Fuse.js 7.1 profiles: immutable object lists,
// weighted top-level keys, ignoreLocation, threshold and minMatchCharLength.
// Texts and queries are lowercased before chunking.
// With ignoreLocation, Bitap's lowest accepted error level is the minimum
// substring edit distance; Myers computes the same distance. Zero edits use
// includes(). A chunk scores max(0.001, errors / length), or 1 if no level matches.
// Queries use 32-character chunks, with an overlapping final chunk if needed;
// text scores average the chunks and need any chunk to match. Whole-query
// equality scores 0 and bypasses chunking and the minimum matching run.
// Conservative filters: each missing character-signature position needs an
// edit; among errors + 1 pattern pieces, at least one survives intact, so all
// its trigrams must occur. Hash collisions only admit extra candidates.
// The minimum run counts consecutive text characters present in the chunk;
// it gates hits without changing chunk scores. Matching fields multiply
// pow(score || Number.EPSILON, raw key weight * token norm)
// in key order, reversing array values. Norms are 1 / sqrt(ASCII-space-delimited
// token count), rounded to 3 decimals. Ties sort by original list index.
const CHUNK = 32;
const peq = new Int32Array(65536); // per-character pattern bitmasks for the current chunk
const GRAM_BITS = 2048; // Hashed trigrams, each stored as a bitset of text IDs

const gramBit = (a, b, c) => Math.imul(Math.imul(Math.imul(a, 0x9e3779b1) ^ b, 0x85ebca6b) ^ c, 0xc2b2ae35) >>> 21;

// Values Fuse indexes for one key, in the order it scores them.
function fieldValues(value) {
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (!Array.isArray(value)) return [];
    const out = [], stack = [value];
    while (stack.length) {
        const v = stack.pop();
        if (typeof v === 'string') { if (v.trim()) out.push(v); }
        else if (Array.isArray(v)) stack.push(...v);
    }
    return out;
}

// Smallest edit distance between the pattern in `peq` (length m) and any
// substring of text (Myers 1999, search variant; branch-free score update).
function minEditDistance(text, m) {
    const top = m - 1;
    let pv = -1, mv = 0, score = m, best = m;
    for (let j = 0, n = text.length; j < n; j++) {
        const eq = peq[text.charCodeAt(j)];
        const xv = eq | mv;
        const xh = (((eq & pv) + pv) ^ pv) | eq;
        const ph = mv | ~(xh | pv);
        const mh = pv & xh;
        score += ((ph >>> top) & 1) - ((mh >>> top) & 1);
        if (score < best) best = score;
        const phShifted = ph << 1;
        pv = (mh << 1) | ~(xv | phShifted);
        mv = phShifted & xv;
    }
    return best;
}

// Per immutable list: distinct lowercased texts, character signatures, token
// norms and one bitset of text IDs per trigram hash. Each key caches record r's
// text IDs in values[offsets[r] .. offsets[r + 1]).
const tables = new WeakMap();

function keyValues(table, list, name) {
    let field = table.keys.get(name);
    if (field) return field;
    const { texts } = table, ids = table.ids ||= new Map(texts.map((text, t) => [text, t]));
    const offsets = new Int32Array(list.length + 1), values = [];
    for (let r = 0; r < list.length; r++) {
        const raw = fieldValues(list[r][name]);
        for (let i = 0; i < raw.length; i++) {
            const lower = raw[i].toLowerCase(), text = lower === raw[i] ? raw[i] : lower; // keeps unchanged corpus strings
            let id = ids.get(text);
            if (id === undefined) { ids.set(text, id = texts.length); texts.push(text); }
            values.push(id);
        }
        offsets[r + 1] = values.length;
    }
    table.keys.set(name, field = { offsets, values: Int32Array.from(values) });
    return field;
}

// Signatures, norms and trigrams for texts[from..], one pass per text. Each hash
// bit owns `rows` 32-text words; when the table grows, existing rows are re-laid out.
function indexTexts(table, from) {
    const { texts, signatures, norms } = table, rows = Math.ceil(texts.length / 32);
    if (rows !== table.rows) {
        const grams = new Int32Array(GRAM_BITS * rows);
        for (let b = 0; b < GRAM_BITS; b++) grams.set(table.grams.subarray(b * table.rows, (b + 1) * table.rows), b * rows);
        Object.assign(table, { grams, rows });
    }
    const { grams } = table;
    for (let t = from; t < texts.length; t++) {
        const text = texts[t], word = t >>> 5, bit = 1 << t;
        let signature = 0, tokens = 0, a = 32, b = 32;
        for (let j = 0; j < text.length; j++) {
            const c = text.charCodeAt(j);
            signature |= 1 << c;
            if (c !== 32 && b === 32) tokens++;
            if (j > 1) grams[gramBit(a, b, c) * rows + word] |= bit;
            a = b; b = c;
        }
        signatures.push(signature);
        norms.push(Math.round((1 / Math.pow(tokens, 0.5)) * 1000) / 1000);
    }
}

// A piece needs all its trigrams; a match needs any intact piece. Intersect
// within pieces and union across them, testing 32 texts at a time.
function candidateBits(grams, words, pieces) {
    const candidates = new Int32Array(words);
    for (const bits of pieces) {
        for (let w = 0; w < words; w++) {
            let mask = -1;
            for (let i = 0; mask && i < bits.length; i++) mask &= grams[bits[i] * words + w];
            candidates[w] |= mask;
        }
    }
    return candidates;
}

// Whether text has `length` consecutive characters that occur in the pattern in `peq`.
function hasRun(text, length) {
    for (let j = 0, run = 0, n = text.length; j < n; j++) {
        if (!peq[text.charCodeAt(j)]) run = 0;
        else if (++run >= length) return true;
    }
    return false;
}

/**
 * @param {readonly object[]} list
 * @param {{ keys: ReadonlyArray<{ name: string, weight: number }>, threshold: number,
 *           minMatchCharLength?: number, ignoreLocation?: boolean }} options
 */
function createFuzzyMatcher(list, { keys, threshold, minMatchCharLength = 1, ignoreLocation = true }) {
    if (!ignoreLocation) throw new Error('createFuzzyMatcher supports ignoreLocation: true only');
    let table = tables.get(list);
    if (!table) tables.set(list, table = { texts: [], signatures: [], norms: [], rows: 0, grams: new Int32Array(0), keys: new Map() });
    const from = table.texts.length, fields = keys.map(({ name, weight = 1 }) => ({ weight, ...keyValues(table, list, name) }));
    table.ids = null; // needed only while adding keys
    if (table.texts.length > from) indexTexts(table, from);
    const { texts, signatures, norms } = table;
    // Each record's values in Fuse's order, and the distinct texts this matcher scans.
    const count = fields.reduce((sum, { values }) => sum + values.length, 0);
    const valueIds = new Int32Array(count), exponents = new Float64Array(count), offsets = new Int32Array(list.length + 1);
    const seen = new Uint8Array(texts.length), scanned = [];
    for (let r = 0, v = 0; r < list.length; r++) {
        for (let f = 0; f < fields.length; f++) {
            const { weight, offsets, values } = fields[f];
            for (let i = offsets[r]; i < offsets[r + 1]; i++, v++) {
                const t = valueIds[v] = values[i];
                exponents[v] = weight * norms[t];
                if (!seen[t]) { seen[t] = 1; scanned.push(t); }
            }
        }
        offsets[r + 1] = v;
    }
    const scan = Int32Array.from(scanned);

    return {
        /**
         * @param {string} query
         * @param {{ limit?: number }} [options]
         * @returns {{ item: object, refIndex: number, score: number }[]}
         */
        search(query, { limit } = {}) {
            const pattern = query.toLowerCase();
            if (!pattern || limit === 0) return [];
            const chunks = [];
            for (let i = 0; i + CHUNK <= pattern.length; i += CHUNK) chunks.push(pattern.slice(i, i + CHUNK));
            if (pattern.length % CHUNK) chunks.push(pattern.slice(Math.max(0, pattern.length - CHUNK)));

            // Per distinct text: sum of chunk scores, and whether any chunk matched.
            const total = new Float64Array(texts.length), hit = new Uint8Array(texts.length);
            const bitCounts = new Int32Array(32);
            for (const chunk of chunks) {
                const m = chunk.length;
                let maxErrors = 0;
                while (maxErrors + 1 < m && (maxErrors + 1) / m <= threshold) maxErrors++;
                let chunkSignature = 0;
                bitCounts.fill(0);
                for (let i = 0; i < m; i++) {
                    const code = chunk.charCodeAt(i);
                    peq[code] |= 1 << i;
                    bitCounts[code & 31]++;
                    chunkSignature |= 1 << code;
                }
                // Every piece must have a trigram for this filter to reject anything.
                const pieces = [];
                if (m >= 3 * (maxErrors + 1)) {
                    for (let i = 0, from = 0; i <= maxErrors; i++) {
                        const to = Math.floor((i + 1) * m / (maxErrors + 1)), bits = [];
                        for (let j = from + 2; j < to; j++) bits.push(gramBit(chunk.charCodeAt(j - 2), chunk.charCodeAt(j - 1), chunk.charCodeAt(j)));
                        pieces.push(bits);
                        from = to;
                    }
                }
                const candidates = pieces.length ? candidateBits(table.grams, table.rows, pieces) : null;
                for (let k = 0; k < scan.length; k++) {
                    const t = scan[k];
                    if (candidates && !(candidates[t >>> 5] & (1 << t))) { total[t] += 1; continue; }
                    const text = texts[t];
                    let missing = 0;
                    for (let x = chunkSignature & ~signatures[t]; x && missing <= maxErrors; x &= x - 1) missing += bitCounts[31 - Math.clz32(x & -x)];
                    const errors = missing > maxErrors ? m
                        : maxErrors === 0 ? (text.includes(chunk) ? 0 : m) : minEditDistance(text, m);
                    if (errors > maxErrors) { total[t] += 1; continue; }
                    total[t] += Math.max(0.001, errors / m);
                    if (minMatchCharLength < 2 || hasRun(text, minMatchCharLength)) hit[t] = 1;
                }
                for (let i = 0; i < m; i++) peq[chunk.charCodeAt(i)] = 0;
            }

            const refs = [], scores = new Float64Array(list.length);
            for (let r = 0; r < list.length; r++) {
                let score = 1, matched = false;
                for (let v = offsets[r]; v < offsets[r + 1]; v++) {
                    const t = valueIds[v];
                    if (texts[t] === pattern) score *= Math.pow(Number.EPSILON, exponents[v]);
                    else if (hit[t]) score *= Math.pow(total[t] / chunks.length, exponents[v]);
                    else continue;
                    matched = true;
                }
                if (matched) { refs.push(r); scores[r] = score; }
            }
            refs.sort((a, b) => scores[a] - scores[b] || a - b);
            const top = typeof limit === 'number' && limit > -1 ? refs.slice(0, limit) : refs;
            return top.map(r => ({ item: list[r], refIndex: r, score: scores[r] }));
        }
    };
}

module.exports = { createFuzzyMatcher };

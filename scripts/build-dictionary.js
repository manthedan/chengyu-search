'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const CEDICT_PATH = path.join(ROOT, 'cedict_ts.u8');
const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const CHENGYU_PATH = path.join(ROOT, 'chengyuData.js');
const OVERRIDES_PATH = path.join(ROOT, 'data', 'dictionary-overrides.json');
const SENTENCE_OVERRIDES_PATH = path.join(ROOT, 'data', 'sentence-overrides.json');

const OUTPUT_DICT = path.join(ROOT, 'public', 'generated', 'dictionary-subset.json');
const OUTPUT_ANNOTATIONS = path.join(ROOT, 'public', 'generated', 'example-annotations.json');
const OUTPUT_AUDIT = path.join(ROOT, 'data', 'coverage-report.json');

// ---------------------------------------------------------------------------
// CEDICT download
// ---------------------------------------------------------------------------

function downloadCedict(targetPath) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading CC-CEDICT from ${CEDICT_URL}...`);
        const tmpPath = targetPath + '.gz';
        const file = fs.createWriteStream(tmpPath);
        https.get(CEDICT_URL, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    const compressed = fs.readFileSync(tmpPath);
                    const decompressed = zlib.gunzipSync(compressed);
                    fs.writeFileSync(targetPath, decompressed);
                    fs.unlinkSync(tmpPath);
                    console.log('Download complete.');
                    resolve();
                } catch (err) {
                    reject(new Error(`Decompression failed: ${err.message}`));
                }
            });
        }).on('error', (err) => {
            fs.unlinkSync(tmpPath);
            reject(err);
        });
    });
}

async function ensureCedictAvailable() {
    if (fs.existsSync(CEDICT_PATH)) return;
    console.log('CC-CEDICT source file not found.');
    await downloadCedict(CEDICT_PATH);
}

// ---------------------------------------------------------------------------
// CEDICT parsing
// ---------------------------------------------------------------------------

const CEDICT_LINE_RE = /^(\S+) (\S+) \[([^\]]+)\] \/(.+)\/\r?$/;

function parseCedict(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];

    for (const line of raw.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const match = line.match(CEDICT_LINE_RE);
        if (!match) continue;

        const [, traditional, simplified, pinyinRaw, defsRaw] = match;
        const definitions = defsRaw.split('/').filter(Boolean);
        const pinyin = pinyinRaw.replace(/u:/g, 'ü').trim();

        entries.push({ traditional, simplified, pinyin, definitions });
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Trie-based dictionary-constrained segmentation
// ---------------------------------------------------------------------------

class TrieNode {
    constructor() {
        this.children = {};
        this.entries = []; // CEDICT entries that end here
    }
}

function buildTrie(entries) {
    const root = new TrieNode();
    for (const entry of entries) {
        const key = entry.simplified;
        let node = root;
        for (const ch of key) {
            if (!node.children[ch]) node.children[ch] = new TrieNode();
            node = node.children[ch];
        }
        node.entries.push(entry);
    }
    return root;
}

/**
 * DP segmentation using dictionary-constrained approach.
 * Returns array of { text, entry } tokens.
 * Falls back to single characters for unknown text.
 */
function segmentWithTrie(text, trie, chengyuSet) {
    const chars = Array.from(text);
    const n = chars.length;

    // dp[i] = { score, path } where path is array of { start, end, entry }
    // dp[i] represents best segmentation of chars[0..i-1]
    const dp = [{ score: 0, path: [] }];

    for (let i = 1; i <= n; i++) {
        let best = null;

        for (let j = 0; j < i; j++) {
            const prev = dp[j];
            if (!prev) continue;

            const substr = chars.slice(j, i).join('');

            // Try to find this substring in the trie
            let node = trie;
            for (const ch of substr) {
                node = node.children[ch];
                if (!node) break;
            }

            if (node && node.entries.length > 0) {
                // Score this token
                let score = prev.score;

                // Prefer longer words
                score += substr.length * 2;

                // Strong preference for chengyu matching
                if (chengyuSet.has(substr)) {
                    score += 10;
                }

                // Prefer multi-char words over single chars
                if (substr.length === 1) {
                    score -= 1;
                }

                // Penalty for very long entries list (ambiguous)
                score -= Math.log2(node.entries.length);

                if (!best || score > best.score) {
                    best = {
                        score,
                        path: [...prev.path, { start: j, end: i, text: substr, entries: node.entries }]
                    };
                }
            }

            // Single-char fallback: if no dictionary match at j..i, allow single char
            // Only try single char if i === j + 1
            if (i === j + 1 && (!node || node.entries.length === 0)) {
                const ch = chars[j];
                if (/[\u3400-\u9fff]/.test(ch)) {
                    // Chinese char with no dictionary entry - mark as uncovered
                    let score = prev.score - 2;
                    if (!best || score > best.score) {
                        best = {
                            score,
                            path: [...prev.path, { start: j, end: i, text: ch, entries: [], uncovered: true }]
                        };
                    }
                } else {
                    // Non-Chinese (punctuation, digits, etc.) - pass through
                    let score = prev.score;
                    if (!best || score > best.score) {
                        best = {
                            score,
                            path: [...prev.path, { start: j, end: i, text: ch, entries: [], nonChinese: true }]
                        };
                    }
                }
            }
        }

        dp[i] = best;
    }

    return dp[n] ? dp[n].path : [];
}

// ---------------------------------------------------------------------------
function segmentHeadword(text, cedictSimplifiedSet) {
    const chars = Array.from(text);
    const n = chars.length;
    if (n <= 1) return [{ text }];

    const dp = [{ score: 0, path: [] }];
    for (let i = 1; i <= n; i++) {
        for (let j = 0; j < i; j++) {
            if (!dp[j]) continue;
            const sub = chars.slice(j, i).join('');
            if (sub === text) continue; // skip whole idiom
            const isChinese = /[\u3400-\u9fff]/.test(sub[0]);
            if (isChinese && sub.length > 1 && cedictSimplifiedSet.has(sub)) {
                const score = dp[j].score + sub.length * 10;
                if (!dp[i] || score > dp[i].score) {
                    dp[i] = { score, path: [...dp[j].path, { text: sub, isWord: true }] };
                }
            }
            if (i === j + 1) {
                const score = dp[j].score + (isChinese ? 0 : 0.5);
                if (!dp[i] || score > dp[i].score) {
                    dp[i] = { score, path: [...dp[j].path, { text: sub, isWord: false }] };
                }
            }
        }
    }

    if (!dp[n]) return chars.map(c => ({ text: c, isWord: false }));
    return dp[n].path;
}

// ---------------------------------------------------------------------------
// Main build logic
// ---------------------------------------------------------------------------

function extractChineseFromExample(example) {
    const match = String(example).match(/^([^(（]+)/);
    return match ? match[1].trim() : String(example).trim();
}

function pickBestEntry(entries, preferSimplified) {
    if (entries.length === 1) return entries[0];
    let best = entries[0];
    let bestScore = -Infinity;
    for (const e of entries) {
        let score = 0;
        const allDefs = e.definitions.join(' ');
        // Strongly penalize variant/old form entries
        if (/old variant|archaic|variant of|erudite/i.test(allDefs)) score -= 10;
        // Penalize surname/proper-name entries
        if (/surname |given name|place name/i.test(allDefs)) score -= 8;
        // Penalize abbreviation entries
        if (/abbr\.|abbreviation/i.test(allDefs)) score -= 5;
        // Penalize "used in" bound-form-only entries (rare usage)
        if (/^used in /.test(allDefs)) score -= 3;
        // Prefer entries without (idiom) tag (those are already in chengyu data)
        if (!allDefs.includes('(idiom)')) score += 1;
        // Prefer entries with more definitions (broader, more common usage)
        score += e.definitions.length;
        // Prefer entries where pinyin matches the most common reading pattern
        if (e.pinyin && !/[,;]/.test(e.pinyin)) score += 0.5;
        // Prefer shorter total definition length (concise = primary meaning)
        score -= allDefs.length * 0.005;
        if (score > bestScore) {
            bestScore = score;
            best = e;
        }
    }
    return best;
}

function loadOverrides() {
    if (fs.existsSync(OVERRIDES_PATH)) {
        return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    }
    return {};
}

function loadSentenceOverrides() {
    if (fs.existsSync(SENTENCE_OVERRIDES_PATH)) {
        return JSON.parse(fs.readFileSync(SENTENCE_OVERRIDES_PATH, 'utf8'));
    }
    return {};
}

function applyOverrideToTrie(trie, overrides) {
    for (const [simplified, data] of Object.entries(overrides)) {
        if (data.definitions || data.pinyin) {
            let node = trie;
            for (const ch of simplified) {
                if (!node.children[ch]) node.children[ch] = new TrieNode();
                node = node.children[ch];
            }
            node.entries = [{
                simplified,
                traditional: data.traditional || simplified,
                pinyin: data.pinyin || '',
                definitions: data.definitions || []
            }];
        }
    }
    return trie;
}

function applySentenceOverride(text, override) {
    // If the override specifies token boundaries, use them
    if (override.tokens && Array.isArray(override.tokens)) {
        let pos = 0;
        const tokens = [];
        for (const tokenText of override.tokens) {
            const idx = text.indexOf(tokenText, pos);
            if (idx < 0) return null; // override doesn't match
            // Add any gap text as non-Chinese tokens
            if (idx > pos) {
                tokens.push({ text: text.slice(pos, idx), entries: [], nonChinese: true });
            }
            tokens.push({ text: tokenText, start: idx, end: idx + tokenText.length });
            pos = idx + tokenText.length;
        }
        // Add trailing text
        if (pos < text.length) {
            tokens.push({ text: text.slice(pos), entries: [], nonChinese: true });
        }
        return tokens;
    }
    return null;
}

async function main() {
    await ensureCedictAvailable();
    console.log('Loading CC-CEDICT...');
    const cedictEntries = parseCedict(CEDICT_PATH);
    console.log(`  Parsed ${cedictEntries.length} CEDICT entries`);

    // Load chengyu data to know which chengyu must stay intact
    const chengyuData = require(CHENGYU_PATH);
    const chengyuSet = new Set(chengyuData.map(e => e.chengyu));
    console.log(`  ${chengyuSet.size} chengyu headwords`);

    // Build simplified-to-traditional map from CEDICT
    const simpToTrad = new Map();
    for (const e of cedictEntries) {
        if (e.simplified && e.traditional && e.traditional !== e.simplified) {
            if (!simpToTrad.has(e.simplified)) {
                simpToTrad.set(e.simplified, e.traditional);
            }
        }
    }

    // Load overrides
    const overrides = loadOverrides();
    const sentenceOverrides = loadSentenceOverrides();
    console.log(`  ${Object.keys(overrides).length} vocabulary overrides`);
    console.log(`  ${Object.keys(sentenceOverrides).length} sentence overrides`);

    // Filter CEDICT to only entries we need
    // We need entries that appear in examples, plus all chengyu, plus overrides
    const chengyuEntries = [];
    for (const e of cedictEntries) {
        if (chengyuSet.has(e.simplified)) {
            chengyuEntries.push(e);
        }
    }

    // Build initial trie from ALL cedict entries (needed for full segmentation)
    // But we'll only output entries that are actually used
    console.log('Building trie...');
    let trie = buildTrie(cedictEntries);

    // Add chengyu entries that aren't in CEDICT so they stay intact during segmentation
    const cedictSimplified = new Set(cedictEntries.map(e => e.simplified));
    let chengyuAddedToTrie = 0;
    for (const entry of chengyuData) {
        if (!cedictSimplified.has(entry.chengyu)) {
            let node = trie;
            for (const ch of entry.chengyu) {
                if (!node.children[ch]) node.children[ch] = new TrieNode();
                node = node.children[ch];
            }
            node.entries.push({
                simplified: entry.chengyu,
                traditional: simpToTrad.get(entry.chengyu) || entry.chengyu,
                pinyin: entry.pinyin,
                definitions: [entry.meaning],
                fromChengyuData: true
            });
            chengyuAddedToTrie++;
        }
    }
    console.log(`  Added ${chengyuAddedToTrie} chengyu to trie not in CEDICT`);

    // Collect all unique chars in chengyu headwords so we can include single-char CEDICT entries
    const headwordChars = new Set();
    for (const entry of chengyuData) {
        for (const ch of entry.chengyu) {
            if (/[\u3400-\u9fff]/.test(ch)) headwordChars.add(ch);
        }
    }

    // Apply vocabulary overrides
    trie = applyOverrideToTrie(trie, overrides);

    const cedictSimplifiedSet = new Set(cedictEntries.map(e => e.simplified));

    // Segmentation
    console.log('Segmenting examples...');
    const dictionarySubset = new Map(); // id -> entry (deduplicated)
    const annotations = {};
    const uncoveredSpans = [];

    // Pre-populate dictionary with single-char CEDICT entries for headword characters
    // Group all entries per character, then pick the best one
    const singleCharGroups = new Map();
    for (const cedictEntry of cedictEntries) {
        if (cedictEntry.simplified.length === 1 && headwordChars.has(cedictEntry.simplified)) {
            const ch = cedictEntry.simplified;
            if (!singleCharGroups.has(ch)) singleCharGroups.set(ch, []);
            singleCharGroups.get(ch).push(cedictEntry);
        }
    }
    let singleCharAdded = 0;
    for (const [ch, entries] of singleCharGroups) {
        const best = pickBestEntry(entries, ch);
        const id = `d:${ch}`;
        dictionarySubset.set(id, {
            id,
            simplified: best.simplified,
            traditional: best.traditional,
            pinyin: best.pinyin,
            definitions: best.definitions
        });
        singleCharAdded++;
    }
    console.log(`  Pre-added ${singleCharAdded} single-char entries for headword characters`);

    for (let idx = 0; idx < chengyuData.length; idx++) {
        const entry = chengyuData[idx];
        const chengyuId = String(idx);
        const zhText = extractChineseFromExample(entry.example);

        if (!zhText) continue;

        let tokens;
        const sOverride = sentenceOverrides[chengyuId];
        if (sOverride) {
            const overrideResult = applySentenceOverride(zhText, sOverride);
            tokens = overrideResult || segmentWithTrie(zhText, trie, chengyuSet);
        } else {
            tokens = segmentWithTrie(zhText, trie, chengyuSet);
        }

        // For override tokens without entries, look them up
        if (sOverride) {
            tokens = tokens.map(t => {
                if (t.entries === undefined && t.start !== undefined) {
                    // Look up in trie
                    let node = trie;
                    for (const ch of t.text) {
                        node = node.children[ch];
                        if (!node) break;
                    }
                    return {
                        ...t,
                        entries: node && node.entries.length > 0 ? node.entries : []
                    };
                }
                return t;
            });
        }

        // Collect dictionary entries used
        const annotationTokens = [];
        for (const token of tokens) {
            if (token.uncovered) {
                uncoveredSpans.push({
                    chengyuId,
                    chengyu: entry.chengyu,
                    text: zhText,
                    uncovered: token.text,
                    position: token.start
                });
                annotationTokens.push({
                    text: token.text,
                    entryIds: [],
                    uncovered: true
                });
            } else if (token.nonChinese) {
                annotationTokens.push({
                    text: token.text,
                    entryIds: [],
                    nonChinese: true
                });
            } else {
                const best = pickBestEntry(token.entries || [], token.text);
                let entryId;

                // For chengyu tokens, use the current entry being annotated
                if (token.text === entry.chengyu) {
                    entryId = `c:${idx}`;
                    dictionarySubset.set(entryId, {
                        id: entryId,
                        simplified: entry.chengyu,
                        traditional: simpToTrad.get(entry.chengyu) || entry.chengyu,
                        pinyin: entry.pinyin,
                        definitions: [entry.meaning],
                        literal: entry.literal,
                        isChengyu: true
                    });
                } else if (chengyuSet.has(token.text)) {
                    // Different chengyu mentioned in the example
                    const chengyuEntry = chengyuData.find(e => e.chengyu === token.text);
                    if (chengyuEntry) {
                        const cIdx = chengyuData.indexOf(chengyuEntry);
                        entryId = `c:${cIdx}`;
                        dictionarySubset.set(entryId, {
                            id: entryId,
                            simplified: chengyuEntry.chengyu,
                            traditional: simpToTrad.get(chengyuEntry.chengyu) || chengyuEntry.chengyu,
                            pinyin: chengyuEntry.pinyin,
                            definitions: [chengyuEntry.meaning],
                            literal: chengyuEntry.literal,
                            isChengyu: true
                        });
                    }
                } else if (best) {
                    // Regular dictionary entry
                    entryId = `d:${best.simplified}`;
                    if (!dictionarySubset.has(entryId)) {
                        dictionarySubset.set(entryId, {
                            id: entryId,
                            simplified: best.simplified,
                            traditional: best.traditional,
                            pinyin: best.pinyin,
                            definitions: best.definitions
                        });
                    }
                }

                annotationTokens.push({
                    text: token.text,
                    entryIds: entryId ? [entryId] : []
                });
            }
        }

        // Segment the headword into sub-words for character-level tooltips
        const headwordSeg = segmentHeadword(entry.chengyu, cedictSimplifiedSet);
        const headwordTokens = headwordSeg.map(seg => {
            if (!/[\u3400-\u9fff]/.test(seg.text[0])) {
                return { text: seg.text, entryIds: [] };
            }
            // Look up the word in CEDICT via trie
            let node = trie;
            for (const ch of seg.text) {
                node = node.children[ch];
                if (!node) break;
            }
            if (node && node.entries.length > 0) {
                const best = pickBestEntry(node.entries, seg.text);
                const id = `d:${best.simplified}`;
                if (!dictionarySubset.has(id)) {
                    dictionarySubset.set(id, {
                        id,
                        simplified: best.simplified,
                        traditional: best.traditional,
                        pinyin: best.pinyin,
                        definitions: best.definitions
                    });
                }
                return { text: seg.text, entryIds: [id] };
            }
            // Single char fallback
            const charId = `d:${seg.text}`;
            if (dictionarySubset.has(charId)) {
                return { text: seg.text, entryIds: [charId] };
            }
            return { text: seg.text, entryIds: [] };
        });

        annotations[chengyuId] = {
            chengyu: entry.chengyu,
            text: zhText,
            tokens: annotationTokens,
            headwordTokens
        };
    }

    console.log('\n--- Coverage Report ---');
    const totalChineseChars = uncoveredSpans.length === 0 ? 0 :
        Object.values(annotations).reduce((sum, a) =>
            sum + a.tokens.filter(t => !t.nonChinese).reduce((s, t) => s + t.text.length, 0), 0);

    console.log(`Dictionary entries: ${dictionarySubset.size}`);
    console.log(`Annotated examples: ${Object.keys(annotations).length}`);
    console.log(`Uncovered spans: ${uncoveredSpans.length}`);

    // Show unique uncovered texts
    const uncoveredUnique = {};
    for (const span of uncoveredSpans) {
        if (!uncoveredUnique[span.uncovered]) {
            uncoveredUnique[span.uncovered] = [];
        }
        uncoveredUnique[span.uncovered].push(span.chengyu);
    }
    console.log(`Unique uncovered words: ${Object.keys(uncoveredUnique).length}`);

    // Show first 50 uncovered for manual override
    const sortedUncovered = Object.entries(uncoveredUnique)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 80);

    if (sortedUncovered.length > 0) {
        console.log('\nMost frequent uncovered words (add to overrides):');
        for (const [word, chengyus] of sortedUncovered) {
            console.log(`  ${word} (${chengyus.length}x) — in: ${chengyus.slice(0, 2).join(', ')}`);
        }
    }

    // Write outputs
    const outputDir = path.dirname(OUTPUT_DICT);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const dictArray = [...dictionarySubset.values()];
    fs.writeFileSync(OUTPUT_DICT, JSON.stringify(dictArray));
    console.log(`\nWrote ${dictArray.length} entries to ${OUTPUT_DICT}`);

    fs.writeFileSync(OUTPUT_ANNOTATIONS, JSON.stringify(annotations));
    console.log(`Wrote ${Object.keys(annotations).length} annotations to ${OUTPUT_ANNOTATIONS}`);

    // Write audit report
    fs.writeFileSync(OUTPUT_AUDIT, JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalEntries: dictArray.length,
        totalAnnotations: Object.keys(annotations).length,
        uncoveredSpans,
        uncoveredUnique: Object.fromEntries(
            Object.entries(uncoveredUnique).sort((a, b) => b[1].length - a[1].length)
        )
    }, null, 2));
    console.log(`Wrote coverage report to ${OUTPUT_AUDIT}`);

    // Exit code for CI
    if (uncoveredSpans.length > 0) {
        console.log(`\n⚠ ${uncoveredSpans.length} uncovered spans remain. Add overrides or dictionary entries.`);
        process.exitCode = 1;
    } else {
        console.log('\n✓ Full coverage achieved.');
    }
}

main().catch(err => {
    console.error('Build failed:', err);
    process.exitCode = 1;
});

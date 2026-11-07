#!/usr/bin/env node
'use strict';
// Builds the deterministic query set for fuzzy-matcher parity and timing:
// benchmark/fuzzy/queries.json. Mixes the labeled relevance queries with
// seeded samples of pinyin (tones, toneless, run-together, typos, partials),
// Chinese fragments, and English words, phrases, typos and long descriptions.
const fs = require('node:fs');
const path = require('node:path');
const { loadChengyuCorpus } = require('../../src/data/corpus-loader');

const OUT = path.join(__dirname, 'queries.json');

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function buildQueries() {
    const { database } = await loadChengyuCorpus();
    const random = mulberry32(20261105);
    const pick = list => list[Math.floor(random() * list.length)];
    const typo = word => {
        if (word.length < 3) return word;
        const i = 1 + Math.floor(random() * (word.length - 2));
        return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    };
    const queries = [];
    const add = (route, query) => { if (query && !queries.some(q => q.query === query)) queries.push({ route, query }); };

    const relevance = require('../../evaluation/datasets/relevance.json');
    for (const row of relevance) add(`labeled:${row.type || 'unknown'}`, row.query);

    const fourChar = database.filter(e => [...(e.simplified || e.chengyu || '')].length === 4 && e.pinyin);
    for (let i = 0; i < 25; i++) add('pinyin:toned', pick(fourChar).pinyin);
    for (let i = 0; i < 25; i++) add('pinyin:toneless', pick(fourChar).pinyin.replace(/[0-9]/g, ''));
    for (let i = 0; i < 20; i++) add('pinyin:joined', pick(fourChar).pinyin.replace(/[0-9\s]/g, ''));
    for (let i = 0; i < 20; i++) {
        const syllables = pick(fourChar).pinyin.replace(/[0-9]/g, '').split(/\s+/);
        const j = Math.floor(random() * syllables.length);
        syllables[j] = typo(syllables[j]);
        add('pinyin:typo', syllables.join(' '));
    }
    for (let i = 0; i < 20; i++) add('pinyin:partial', pick(fourChar).pinyin.replace(/[0-9]/g, '').split(/\s+/).slice(0, 2).join(' '));

    for (let i = 0; i < 15; i++) add('chinese:two', [...pick(fourChar).simplified].slice(0, 2).join(''));
    for (let i = 0; i < 15; i++) add('chinese:three', [...pick(fourChar).simplified].slice(1, 4).join(''));
    for (let i = 0; i < 15; i++) {
        const chars = [...pick(fourChar).simplified];
        chars[Math.floor(random() * 4)] = [...pick(fourChar).simplified][Math.floor(random() * 4)];
        add('chinese:altered', chars.join(''));
    }

    const meaningWords = database.flatMap(e => String(e.meaning || '').toLowerCase().match(/[a-z]{4,}/g) || []);
    for (let i = 0; i < 30; i++) add('english:word', pick(meaningWords));
    for (let i = 0; i < 30; i++) {
        const words = String(pick(database).meaning || '').toLowerCase().match(/[a-z']+/g) || [];
        const start = Math.floor(random() * Math.max(1, words.length - 3));
        add('english:phrase', words.slice(start, start + 2 + Math.floor(random() * 3)).join(' '));
    }
    for (let i = 0; i < 20; i++) add('english:typo', typo(pick(meaningWords)));
    for (const query of [
        'adding something unnecessary and ruining it', 'easier said than done', 'frog in a well',
        'It was already done, then I added something extra and ruined it', 'Pretending to be dumb to avoid answering',
        'A clever and quick-witted child', 'Hesitant and unable to move forward', 'It sounded easier than it was',
        'I added one more thing and ruined it', 'Just waiting around instead of taking initiative',
        'She keeps contradicting herself', 'Getting rejected might be a blessing in disguise',
        'my effort is wasted on an audience that doesn\'t get it', 'love', 'fart', 'making things worse'
    ]) add('english:long', query);

    return queries;
}

if (require.main === module) {
    buildQueries().then(queries => {
        fs.writeFileSync(OUT, `${JSON.stringify(queries, null, 1)}\n`);
        const counts = {};
        for (const q of queries) counts[q.route.split(':')[0]] = (counts[q.route.split(':')[0]] || 0) + 1;
        console.log(`Wrote ${queries.length} queries to ${path.relative(process.cwd(), OUT)}`, counts);
    });
}

module.exports = { buildQueries };

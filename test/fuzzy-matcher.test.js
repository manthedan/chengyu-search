// Randomized differential test: createFuzzyMatcher must agree exactly with
// fuse.js 7.1 (a devDependency) beyond the recorded oracle, on small
// alphabets that stress edit-distance ties, queries split into 32-character
// chunks, array fields, blank and non-string values, and minMatchCharLength.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const Fuse = require('fuse.js');
const { createFuzzyMatcher } = require('../src/search/fuzzy-matcher');

function rng(seed) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('fuzzy matcher agrees with fuse.js on random data', () => {
    const random = rng(20261105);
    const pick = items => items[Math.floor(random() * items.length)];
    const word = (alphabet, max) => Array.from({ length: 1 + Math.floor(random() * max) }, () => pick(alphabet)).join('');
    const alphabet = ['a', 'b', 'c', 'A', ' ', ' ', '画', 'é'];
    const docs = Array.from({ length: 300 }, () => ({
        title: pick([word(alphabet, 6), word(alphabet, 40), '', '   ', 7, null]),
        body: word(alphabet, 120),
        tags: pick([[], [word(alphabet, 8), word(alphabet, 8)], [word(alphabet, 5), ['ab', ' '], null, 3]])
    }));
    const keys = [{ name: 'title', weight: 0.5 }, { name: 'body', weight: 0.2 }, { name: 'tags', weight: 0.35 }];

    for (const threshold of [0.2, 0.24, 0.4]) {
        for (const minMatchCharLength of [1, 2, 3]) {
            it(`threshold ${threshold}, minMatchCharLength ${minMatchCharLength}`, () => {
                const options = { keys, threshold, minMatchCharLength, ignoreLocation: true };
                const fuse = new Fuse(docs, { ...options, includeScore: true });
                const matcher = createFuzzyMatcher(docs, options);
                for (let i = 0; i < 40; i++) {
                    const query = i % 5 === 0 ? String(pick(docs).title) : word(alphabet, pick([3, 12, 40, 75]));
                    const limit = pick([undefined, -1, 5, 30]);
                    const expected = fuse.search(query, { limit }).map(({ refIndex, score }) => [refIndex, score]);
                    const actual = matcher.search(query, { limit }).map(({ refIndex, score }) => [refIndex, score]);
                    assert.deepStrictEqual(actual, expected, `query ${JSON.stringify(query)}`);
                }
            });
        }
    }

    it('preserves blank queries, whitespace, and numeric limit semantics', () => {
        const list = ['', ' ', '\t\n', 'a', ' a ', 'a  b', 'a\tb', 'a\nb', '\u00a0a\u00a0', 'İ Σ😀', 'ΟΣ', 0, false, null]
            .map(title => ({ title }));
        for (const minMatchCharLength of [1, 2, 3]) {
            const options = { keys: [keys[0]], threshold: 0.24, minMatchCharLength, ignoreLocation: true };
            const fuse = new Fuse(list, { ...options, includeScore: true });
            const matcher = createFuzzyMatcher(list, options);
            for (const query of ['', ' ', '  ', '\t', '\n', '\u00a0', 'a', '0', 'false', 'i\u0307', 'ος', '😀']) {
                for (const limit of [undefined, -2, -1, -0.5, 0, 0.5, 1, 2, Infinity, NaN, null, '1']) {
                    assert.deepStrictEqual(matcher.search(query, { limit }), fuse.search(query, { limit }),
                        `query ${JSON.stringify(query)}, limit ${limit}, minMatchCharLength ${minMatchCharLength}`);
                }
            }
        }
        const options = { keys, threshold: 0.24, ignoreLocation: true };
        assert.deepStrictEqual(createFuzzyMatcher([], options).search('a'), []);
    });

    it('matches at 32-bit chunk boundaries, including overlapping final chunks', () => {
        for (const length of [31, 32, 33, 63, 64, 65, 96, 97]) {
            const query = Array.from({ length }, () => pick(['a', 'b', 'c', '画', 'é'])).join('');
            const list = [query, query.toLowerCase(), `xx${query}yy`, query.slice(0, 32), query.slice(-32),
                query.slice(0, 12) + 'x' + query.slice(13), 'unrelated', ' '].map(title => ({ title }));
            for (const minMatchCharLength of [1, 2, 3]) {
                const options = { keys: [keys[0]], threshold: 0.24, minMatchCharLength, ignoreLocation: true };
                const fuse = new Fuse(list, { ...options, includeScore: true });
                const matcher = createFuzzyMatcher(list, options);
                for (const limit of [-1, 0, 2]) {
                    assert.deepStrictEqual(matcher.search(query, { limit }), fuse.search(query, { limit }),
                        `length ${length}, limit ${limit}, minMatchCharLength ${minMatchCharLength}`);
                }
            }
        }
    });

    it('matchers over one list with different keys share its text table', () => {
        // A fresh list, so its shared table grows with each matcher's new keys.
        const list = docs.slice(), options = { threshold: 0.4, minMatchCharLength: 1, ignoreLocation: true };
        const profiles = [[keys[2]], [keys[1], keys[2]], keys].map(subset => {
            const fuse = new Fuse(list, { ...options, keys: subset, includeScore: true });
            return { fuse, matcher: createFuzzyMatcher(list, { ...options, keys: subset }) };
        });
        for (let i = 0; i < 60; i++) {
            const { fuse, matcher } = profiles[i % 3];
            const query = word(alphabet, pick([3, 12, 40]));
            const expected = fuse.search(query).map(({ refIndex, score }) => [refIndex, score]);
            assert.deepStrictEqual(matcher.search(query).map(({ refIndex, score }) => [refIndex, score]), expected, `query ${JSON.stringify(query)}`);
        }
    });
});

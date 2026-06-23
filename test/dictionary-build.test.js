'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DICT_PATH = path.join(ROOT, 'public', 'generated', 'dictionary-subset.json');
const ANN_PATH = path.join(ROOT, 'public', 'generated', 'example-annotations.json');

function loadDictionary() {
    if (!fs.existsSync(DICT_PATH)) return null;
    return JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
}

function loadAnnotations() {
    if (!fs.existsSync(ANN_PATH)) return null;
    return JSON.parse(fs.readFileSync(ANN_PATH, 'utf8'));
}

describe('dictionary build output', () => {
    let dict, annotations;

    before(() => {
        dict = loadDictionary();
        annotations = loadAnnotations();
    });

    it('should produce a dictionary subset file', () => {
        assert.ok(dict, 'dictionary-subset.json should exist');
        assert.ok(Array.isArray(dict), 'dictionary should be an array');
        assert.ok(dict.length > 1000, `dictionary should have many entries, got ${dict.length}`);
    });

    it('should produce an annotations file', () => {
        assert.ok(annotations, 'example-annotations.json should exist');
        assert.ok(typeof annotations === 'object', 'annotations should be an object');
        assert.ok(Object.keys(annotations).length > 5000, `should have many annotations, got ${Object.keys(annotations).length}`);
    });

    it('should include required fields on every dictionary entry', () => {
        for (const entry of dict.slice(0, 200)) {
            assert.ok(entry.id, `entry ${JSON.stringify(entry).slice(0, 80)} missing id`);
            assert.ok(entry.simplified, `entry ${entry.id} missing simplified`);
            assert.ok(typeof entry.definitions === 'object' && entry.definitions.length > 0,
                `entry ${entry.id} missing definitions`);
        }
    });

    it('should mark chengyu entries with isChengyu flag', () => {
        const chengyuEntries = dict.filter(e => e.isChengyu);
        assert.ok(chengyuEntries.length > 3000, `expected 3000+ chengyu entries, got ${chengyuEntries.length}`);
        for (const entry of chengyuEntries.slice(0, 10)) {
            assert.ok(entry.literal, `chengyu entry ${entry.id} should have literal meaning`);
        }
    });

    it('should segment example sentences into tokens with entry references', () => {
        const keys = Object.keys(annotations);
        const sample = annotations[keys[0]];
        assert.ok(sample.tokens, 'annotation should have tokens');
        assert.ok(sample.tokens.length > 0, 'annotation should have at least one token');

        // Most tokens should have entry references
        const withEntries = sample.tokens.filter(t => t.entryIds && t.entryIds.length > 0);
        assert.ok(withEntries.length > 0, 'at least some tokens should reference dictionary entries');
    });

    it('should achieve full coverage (no uncovered spans)', () => {
        let uncovered = 0;
        for (const [, ann] of Object.entries(annotations)) {
            for (const token of ann.tokens) {
                if (token.uncovered) uncovered++;
            }
        }
        assert.strictEqual(uncovered, 0, `${uncovered} uncovered spans remain`);
    });

    it('should reference valid entry IDs in annotations', () => {
        const dictIds = new Set(dict.map(e => e.id));
        const keys = Object.keys(annotations).slice(0, 100);
        for (const key of keys) {
            const ann = annotations[key];
            for (const token of ann.tokens) {
                if (token.entryIds) {
                    for (const id of token.entryIds) {
                        assert.ok(dictIds.has(id),
                            `annotation ${key} references unknown entry id: ${id}`);
                    }
                }
            }
        }
    });
});

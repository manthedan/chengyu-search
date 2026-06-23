const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(initial = {}) {
    return {
        value: '',
        innerHTML: '',
        listeners: {},
        classList: {
            add() {},
            remove() {}
        },
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        click() {
            this.listeners.click?.({ currentTarget: this, preventDefault() {} });
        },
        remove() {},
        ...initial
    };
}

function loadFrontendWithDictionary(dictData, annData) {
    const utilsSourcePath = path.join(__dirname, '..', 'public', 'frontend-utils.js');
    const storageSourcePath = path.join(__dirname, '..', 'public', 'frontend-storage.js');
    const apiSourcePath = path.join(__dirname, '..', 'public', 'frontend-api.js');
    const ankiSourcePath = path.join(__dirname, '..', 'public', 'frontend-anki.js');
    const bookmarksSourcePath = path.join(__dirname, '..', 'public', 'frontend-bookmarks.js');
    const speechSourcePath = path.join(__dirname, '..', 'public', 'frontend-speech.js');
    const dictionarySourcePath = path.join(__dirname, '..', 'public', 'frontend-dictionary.js');
    const sourcePath = path.join(__dirname, '..', 'public', 'app.js');
    const utilsSource = fs.readFileSync(utilsSourcePath, 'utf8');
    const storageSource = fs.readFileSync(storageSourcePath, 'utf8');
    const apiSource = fs.readFileSync(apiSourcePath, 'utf8');
    const ankiSource = fs.readFileSync(ankiSourcePath, 'utf8');
    const bookmarksSource = fs.readFileSync(bookmarksSourcePath, 'utf8');
    const speechSource = fs.readFileSync(speechSourcePath, 'utf8');
    const dictionarySource = fs.readFileSync(dictionarySourcePath, 'utf8');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const augmentedSource = `${utilsSource}\n${storageSource}\n${apiSource}\n${ankiSource}\n${bookmarksSource}\n${speechSource}\n${dictionarySource}\n${source}
;globalThis.__APP_TEST_HOOKS__ = {
    render,
    renderResultCard,
    renderCharacterCluster,
    renderAnnotatedExample,
    buildPopoverContent,
    highlightIdiomPlain,
    getDisplayHeadword,
    getState: () => STATE,
    setScriptMode: value => { STATE.scriptMode = value; },
    setResults: value => { STATE.results = value; },
    getDictionary: () => DICTIONARY
};`;

    const elements = new Map();
    const document = {
        body: { dataset: {}, append() {} },
        getElementById(id) { return elements.get(id) || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return createElement(); },
        addEventListener() {}
    };

    const window = {
        location: { origin: 'http://example.test' },
        innerWidth: 1024,
        innerHeight: 768,
        speechSynthesis: {
            getVoices() { return []; },
            addEventListener() {},
            removeEventListener() {},
            cancel() {},
            speak() {}
        }
    };

    const fetchImpl = async (url) => {
        if (String(url).includes('dictionary-subset')) {
            return { ok: true, async json() { return dictData; } };
        }
        if (String(url).includes('example-annotations')) {
            return { ok: true, async json() { return annData; } };
        }
        return { ok: true, async json() { return { status: 'ok', database: true }; } };
    };

    const sandbox = {
        console,
        document,
        window,
        localStorage: {
            getItem() { return null; },
            setItem() {}
        },
        navigator: {
            clipboard: { async writeText() {} }
        },
        fetch: fetchImpl,
        Blob: class Blob {
            constructor(parts, options) { this.parts = parts; this.options = options; }
        },
        URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
        SpeechSynthesisUtterance: function SpeechSynthesisUtterance(text) { this.text = text; },
        setTimeout,
        clearTimeout,
        globalThis: null
    };
    sandbox.globalThis = sandbox;

    vm.runInNewContext(augmentedSource, sandbox, { filename: 'public/app.js' });

    return { hooks: sandbox.__APP_TEST_HOOKS__, elements };
}

const DICT_DATA = [
    { id: 'c:0', simplified: '聪明伶俐', traditional: '聰明伶俐', pinyin: 'cong1 ming2 ling2 li4', definitions: ['clever and intelligent'], literal: 'clever bright clever sharp', isChengyu: true },
    { id: 'd:聪明', simplified: '聪明', traditional: '聰明', pinyin: 'cong1 ming2', definitions: ['intelligent; clever'] },
    { id: 'd:伶俐', simplified: '伶俐', traditional: '伶俐', pinyin: 'ling2 li4', definitions: ['clever; sharp; smart'] },
    { id: 'd:画', simplified: '画', traditional: '畫', pinyin: 'hua4', definitions: ['to draw; to paint'] },
    { id: 'd:蛇', simplified: '蛇', traditional: '蛇', pinyin: 'she2', definitions: ['snake; serpent'] },
    { id: 'd:添', simplified: '添', traditional: '添', pinyin: 'tian1', definitions: ['to add; to increase'] },
    { id: 'd:足', simplified: '足', traditional: '足', pinyin: 'zu2', definitions: ['foot; sufficient'] },
    { id: 'd:这', simplified: '这', traditional: '這', pinyin: 'zhe4', definitions: ['this'] },
    { id: 'd:次', simplified: '次', traditional: '次', pinyin: 'ci4', definitions: ['next in sequence'] },
    { id: 'd:改进', simplified: '改进', traditional: '改進', pinyin: 'gai3 jin4', definitions: ['to improve'] },
    { id: 'd:方案', simplified: '方案', traditional: '方案', pinyin: 'fang1 an4', definitions: ['plan'] },
    { id: 'd:反而', simplified: '反而', traditional: '反而', pinyin: 'fan3 er2', definitions: ['on the contrary'] },
    { id: 'd:复杂', simplified: '复杂', traditional: '複雜', pinyin: 'fu4 za2', definitions: ['complicated; complex'] },
    { id: 'c:1', simplified: '画蛇添足', traditional: '畫蛇添足', pinyin: 'hua4 she2 tian1 zu2', definitions: ['to ruin by overdoing'], literal: 'draw snake add feet', isChengyu: true },
];

const ANN_DATA = {
    '0': {
        chengyu: '聪明伶俐',
        text: '她从小就很聪明伶俐，深受老师喜爱。',
        tokens: [
            { text: '她', entryIds: [] },
            { text: '从小', entryIds: [] },
            { text: '就', entryIds: [] },
            { text: '很', entryIds: [] },
            { text: '聪明伶俐', entryIds: ['c:0'] },
            { text: '，', nonChinese: true },
            { text: '深受', entryIds: [] },
            { text: '老师', entryIds: [] },
            { text: '喜爱', entryIds: [] },
            { text: '。', nonChinese: true }
        ],
        headwordTokens: [
            { text: '聪明', entryIds: ['d:聪明'] },
            { text: '伶俐', entryIds: ['d:伶俐'] }
        ]
    },
    '1': {
        chengyu: '画蛇添足',
        text: '这次改进方案反而画蛇添足，使得项目变得更加复杂。',
        tokens: [
            { text: '这', entryIds: ['d:这'] },
            { text: '次', entryIds: ['d:次'] },
            { text: '改进', entryIds: ['d:改进'] },
            { text: '方案', entryIds: ['d:方案'] },
            { text: '反而', entryIds: ['d:反而'] },
            { text: '画蛇添足', entryIds: ['c:1'] },
            { text: '，', nonChinese: true },
            { text: '使得', entryIds: [] },
            { text: '整个', entryIds: [] },
            { text: '项目', entryIds: [] },
            { text: '变得', entryIds: [] },
            { text: '更加', entryIds: [] },
            { text: '复杂', entryIds: ['d:复杂'] },
            { text: '。', nonChinese: true }
        ],
        headwordTokens: [
            { text: '画', entryIds: ['d:画'] },
            { text: '蛇', entryIds: ['d:蛇'] },
            { text: '添', entryIds: ['d:添'] },
            { text: '足', entryIds: ['d:足'] }
        ]
    }
};

describe('dictionary tooltip frontend', () => {

    it('renders segmented headword words as grouped clickable units', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        // Simulate dictionary loaded state
        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;

        const result = {
            chengyu: '聪明伶俐',
            simplified: '聪明伶俐',
            traditional: '聰明伶俐',
            pinyin: 'cong1 ming2 ling2 li4',
            literal: 'clever bright clever sharp',
            meaning: 'clever and intelligent',
            example: '她从小就很聪明伶俐，深受老师喜爱。',
            tags: ['clever'],
            formality: 'formal'
        };

        hooks.setResults([result]);
        const markup = hooks.renderCharacterCluster(result);

        // Should have two word-grouped spans, not four individual char spans
        assert.match(markup, /data-dict-entry="d:聪明"/);
        assert.match(markup, /data-dict-entry="d:伶俐"/);
        assert.doesNotMatch(markup, /data-dict-char/);
    });

    it('renders individual chars with data-dict-char when no sub-word grouping exists', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;

        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add feet',
            meaning: 'to ruin by overdoing',
            example: '这次改进方案反而画蛇添足。',
            tags: ['warning'],
            formality: 'formal'
        };

        hooks.setResults([result]);
        const markup = hooks.renderCharacterCluster(result);

        // Each char should have data-dict-entry (single chars with entries)
        assert.match(markup, /data-dict-entry="d:画"/);
        assert.match(markup, /data-dict-entry="d:蛇"/);
        assert.match(markup, /data-dict-entry="d:添"/);
        assert.match(markup, /data-dict-entry="d:足"/);
    });

    it('renders annotated example tokens as clickable spans', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;

        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add feet',
            meaning: 'to ruin by overdoing',
            example: '这次改进方案反而画蛇添足，使得项目变得更加复杂。',
            tags: ['warning'],
            formality: 'formal'
        };

        const markup = hooks.renderAnnotatedExample('这次改进方案反而画蛇添足，使得项目变得更加复杂。', result);

        // Chengyu token should be highlighted with data-dict-entry
        assert.match(markup, /dict-token highlight.*data-dict-entry="c:1"/);
        // Other tokens should also be clickable
        assert.match(markup, /data-dict-entry="d:改进"/);
        assert.match(markup, /data-dict-entry="d:方案"/);
    });

    it('falls back to plain highlight when dictionary not loaded', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        // Dictionary NOT loaded
        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add feet',
            meaning: 'to ruin by overdoing',
            example: '画蛇添足。',
            tags: [],
            formality: 'formal'
        };

        hooks.setResults([result]);
        const markup = hooks.highlightIdiomPlain('这次画蛇添足了。', result);

        assert.match(markup, /<span class="highlight">画蛇添足<\/span>/);
        assert.doesNotMatch(markup, /dict-token/);
    });

    it('builds popover content with word, pinyin, and definitions', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));

        const entry = dict.entries.get('d:伶俐');
        const content = hooks.buildPopoverContent([entry]);

        assert.match(content, /伶俐/);
        assert.match(content, /clever; sharp; smart/);
        assert.match(content, /dict-pop-pinyin/);
    });

    it('builds popover content with chengyu literal meaning', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));

        const entry = dict.entries.get('c:1');
        const content = hooks.buildPopoverContent([entry]);

        assert.match(content, /画蛇添足/);
        assert.match(content, /dict-pop-literal/);
        assert.match(content, /draw snake add feet/);
        assert.match(content, /dict-pop-tag/);
    });

    it('renders result card with popover container', () => {
        const { hooks, elements } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;
        dict.charIndex = new Map();
        for (const e of DICT_DATA) {
            if (e.simplified && e.simplified.length === 1) {
                dict.charIndex.set(e.simplified, e);
            }
        }

        const app = createElement();
        elements.set('app', app);

        const result = {
            chengyu: '聪明伶俐',
            simplified: '聪明伶俐',
            traditional: '聰明伶俐',
            pinyin: 'cong1 ming2 ling2 li4',
            literal: 'clever bright clever sharp',
            meaning: 'clever and intelligent',
            example: '她从小就很聪明伶俐，深受老师喜爱。',
            tags: ['clever'],
            formality: 'formal'
        };

        hooks.setResults([result]);
        hooks.getState().view = 'results';
        hooks.getState().search = { query: 'clever', hasMore: false, nextOffset: null, loadedCount: 1 };
        hooks.render();

        assert.match(app.innerHTML, /id="dictionary-popover"/);
        assert.match(app.innerHTML, /dict-token/);
    });

    it('respects traditional script mode in segmented headwords', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;

        const result = {
            chengyu: '聪明伶俐',
            simplified: '聪明伶俐',
            traditional: '聰明伶俐',
            pinyin: 'cong1 ming2 ling2 li4',
            literal: 'clever bright clever sharp',
            meaning: 'clever and intelligent',
            example: '她从小就很聪明伶俐。',
            tags: [],
            formality: 'formal'
        };

        hooks.setScriptMode('traditional');
        const markup = hooks.renderCharacterCluster(result);

        // Should show traditional chars (pins interleave between characters)
        assert.match(markup, /聰/);
        assert.match(markup, /明/);
        assert.match(markup, /伶/);
        assert.match(markup, /俐/);
        // Entry ID uses simplified key but display chars are traditional
        assert.match(markup, /data-dict-entry="d:聪明"/);
    });

    it('annotated example tokens convert to traditional script', () => {
        const { hooks } = loadFrontendWithDictionary(DICT_DATA, ANN_DATA);

        const dict = hooks.getDictionary();
        dict.loaded = true;
        dict.entries = new Map(DICT_DATA.map(e => [e.id, e]));
        dict.annotations = ANN_DATA;

        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add feet',
            meaning: 'to ruin by overdoing',
            example: '这次改进方案反而画蛇添足。',
            tags: [],
            formality: 'formal'
        };

        hooks.setScriptMode('traditional');
        const text = ANN_DATA['1'].text;
        const markup = hooks.renderAnnotatedExample(text, result);

        // Should show traditional forms
        assert.match(markup, /改進/);
        assert.match(markup, /畫蛇添足/);
    });
});

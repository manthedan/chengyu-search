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

function loadFrontendApp(options = {}) {
    const sourcePath = path.join(__dirname, '..', 'public', 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const augmentedSource = `${source}
;globalThis.__APP_TEST_HOOKS__ = {
    bind,
    render,
    renderHeader,
    renderSearchSection,
    renderSavedSection,
    renderFooter,
    renderResultCard,
    getDisplayHeadword,
    findResultByPublicId,
    buildCopyPayload,
    copyResult,
    buildAnkiFieldColumns,
    buildAnkiExportContent,
    refreshBookmarksIfNeeded,
    getState: () => STATE,
    setScriptMode: value => { STATE.scriptMode = value; },
    setView: value => { STATE.view = value; },
    setResults: value => { STATE.results = value; },
    setBookmarks: value => { STATE.bookmarks = value; },
    setSavedOpen: value => { STATE.savedOpen = value; }
};`;

    const elements = new Map();
    const localStorageStore = new Map(Object.entries(options.initialLocalStorage || {}));
    const clipboardWrites = [];

    const document = {
        body: {
            dataset: {},
            append() {}
        },
        getElementById(id) {
            return elements.get(id) || null;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        createElement() {
            return createElement();
        },
        addEventListener() {}
    };

    const localStorage = {
        getItem(key) {
            return localStorageStore.has(key) ? localStorageStore.get(key) : null;
        },
        setItem(key, value) {
            localStorageStore.set(key, String(value));
        }
    };

    const window = {
        location: { origin: 'http://example.test' },
        speechSynthesis: {
            getVoices() {
                return [];
            },
            addEventListener() {},
            removeEventListener() {},
            cancel() {},
            speak() {}
        }
    };

    const fetchImpl = options.fetchImpl || (async () => ({
        ok: true,
        async json() {
            return { status: 'ok', database: true };
        }
    }));

    const sandbox = {
        console,
        document,
        window,
        localStorage,
        navigator: {
            clipboard: {
                async writeText(value) {
                    clipboardWrites.push(value);
                }
            }
        },
        fetch: (...args) => fetchImpl(...args),
        Blob: class Blob {
            constructor(parts, options) {
                this.parts = parts;
                this.options = options;
            }
        },
        URL: {
            createObjectURL() {
                return 'blob:test';
            },
            revokeObjectURL() {}
        },
        SpeechSynthesisUtterance: function SpeechSynthesisUtterance(text) {
            this.text = text;
        },
        setTimeout,
        clearTimeout,
        globalThis: null
    };

    sandbox.globalThis = sandbox;

    vm.runInNewContext(augmentedSource, sandbox, { filename: 'public/app.js' });

    return {
        hooks: sandbox.__APP_TEST_HOOKS__,
        elements,
        localStorage,
        localStorageStore,
        clipboardWrites
    };
}

describe('frontend script toggle', () => {
    it('toggles script mode and persists the choice through the header control', () => {
        const { hooks, elements, localStorage } = loadFrontendApp();
        const scriptToggle = createElement();
        const searchInput = createElement({ value: '' });
        const app = createElement();

        elements.set('app', app);
        elements.set('script-toggle', scriptToggle);
        elements.set('search-input', searchInput);

        assert.strictEqual(hooks.getState().scriptMode, 'simplified');
        hooks.bind();

        scriptToggle.click();
        assert.strictEqual(hooks.getState().scriptMode, 'traditional');
        assert.strictEqual(localStorage.getItem('chengyu-script-mode'), 'traditional');

        scriptToggle.click();
        assert.strictEqual(hooks.getState().scriptMode, 'simplified');
        assert.strictEqual(localStorage.getItem('chengyu-script-mode'), 'simplified');
    });

    it('renders landing example glosses in the selected script', () => {
        const { hooks } = loadFrontendApp();
        hooks.setView('landing');

        hooks.setScriptMode('simplified');
        const simplifiedMarkup = hooks.renderSearchSection();
        assert.match(simplifiedMarkup, /画蛇添足/);
        assert.doesNotMatch(simplifiedMarkup, /畫蛇添足/);

        hooks.setScriptMode('traditional');
        const traditionalMarkup = hooks.renderSearchSection();
        assert.match(traditionalMarkup, /畫蛇添足/);
        assert.doesNotMatch(traditionalMarkup, /画蛇添足/);
    });

    it('renders result headwords and visible idiom highlights in the selected script', () => {
        const { hooks } = loadFrontendApp();
        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'Draw a snake, add legs.',
            meaning: 'To ruin the effect by adding something superfluous.',
            example: '这已经够好了，别再画蛇添足了。（This is already good enough—do not overdo it.）',
            tags: ['warning'],
            formality: 'formal'
        };

        hooks.setScriptMode('simplified');
        const simplifiedMarkup = hooks.renderResultCard(result, 0);
        assert.match(simplifiedMarkup, /pin">huà<\/span>画/);
        assert.doesNotMatch(simplifiedMarkup, /pin">huà<\/span>畫/);
        assert.match(simplifiedMarkup, /<span class="highlight">画蛇添足<\/span>/);
        assert.doesNotMatch(simplifiedMarkup, /<span class="highlight">畫蛇添足<\/span>/);

        hooks.setScriptMode('traditional');
        const traditionalMarkup = hooks.renderResultCard(result, 0);
        assert.match(traditionalMarkup, /pin">huà<\/span>畫/);
        assert.doesNotMatch(traditionalMarkup, /pin">huà<\/span>画/);
        assert.match(traditionalMarkup, /<span class="highlight">畫蛇添足<\/span>/);
        assert.doesNotMatch(traditionalMarkup, /<span class="highlight">画蛇添足<\/span>/);
    });

    it('copies only the Chinese headword in the selected script', async () => {
        const { hooks, clipboardWrites } = loadFrontendApp();
        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            meaning: 'To ruin the effect by adding something superfluous.'
        };

        hooks.setScriptMode('simplified');
        assert.strictEqual(hooks.buildCopyPayload(result), '画蛇添足');
        await hooks.copyResult(result, createElement({ innerHTML: 'Copy' }));
        assert.strictEqual(clipboardWrites.at(-1), '画蛇添足');

        hooks.setScriptMode('traditional');
        assert.strictEqual(hooks.buildCopyPayload(result), '畫蛇添足');
        await hooks.copyResult(result, createElement({ innerHTML: 'Copy' }));
        assert.strictEqual(clipboardWrites.at(-1), '畫蛇添足');
    });

    it('renders and resolves saved-result actions by stable public id', () => {
        const { hooks } = loadFrontendApp();
        const first = {
            id: 'chengyu_first',
            chengyu: '难兄难弟',
            simplified: '难兄难弟',
            traditional: '難兄難弟',
            pinyin: 'nan2 xiong1 nan2 di4',
            literal: 'difficult brother difficult brother',
            meaning: 'one is just as bad as the other',
            tags: [],
            formality: 'formal'
        };
        const second = {
            id: 'chengyu_second',
            chengyu: '难兄难弟',
            simplified: '难兄难弟',
            traditional: '難兄難弟',
            pinyin: 'nan4 xiong1 nan4 di4',
            literal: 'difficult brother difficult younger brother',
            meaning: 'fellow sufferers',
            tags: [],
            formality: 'formal'
        };

        hooks.setResults([first]);
        hooks.setBookmarks({ [second.id]: second });
        hooks.setSavedOpen(true);

        const savedMarkup = hooks.renderSavedSection();
        assert.match(savedMarkup, /data-result-id="chengyu_second"/);

        const resultMarkup = hooks.renderResultCard(first, 0);
        assert.match(resultMarkup, /data-result-id="chengyu_first"/);

        assert.strictEqual(hooks.findResultByPublicId('chengyu_second', '难兄难弟').pinyin, 'nan4 xiong1 nan4 di4');
        assert.strictEqual(hooks.findResultByPublicId('', '难兄难弟').pinyin, 'nan2 xiong1 nan2 di4');
    });

    it('refreshes older saved bookmarks so script toggling works for existing local saves', async () => {
        const oldBookmark = {
            '画蛇添足': {
                chengyu: '画蛇添足',
                pinyin: 'hua4 she2 tian1 zu2',
                literal: 'Draw a snake, add legs.',
                meaning: 'To ruin the effect by adding something superfluous.'
            }
        };

        const refreshedResult = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'Draw a snake, add legs.',
            meaning: 'To ruin the effect by adding something superfluous.',
            example: '这已经够好了，别再画蛇添足了。（This is already good enough—do not overdo it.）',
            tags: ['warning'],
            formality: 'formal'
        };

        const { hooks, localStorage } = loadFrontendApp({
            initialLocalStorage: {
                'chengyu-bookmarks': JSON.stringify(oldBookmark)
            },
            fetchImpl: async (url, options) => {
                if (String(url).endsWith('/api/search/keyword')) {
                    const payload = JSON.parse(options.body);
                    assert.strictEqual(payload.query, '画蛇添足');
                    return {
                        ok: true,
                        async json() {
                            return { results: [refreshedResult] };
                        }
                    };
                }

                return {
                    ok: true,
                    async json() {
                        return { status: 'ok', database: true };
                    }
                };
            }
        });

        const changed = await hooks.refreshBookmarksIfNeeded();
        assert.strictEqual(changed, true);
        assert.strictEqual(hooks.getState().bookmarks['画蛇添足'].traditional, '畫蛇添足');
        assert.match(localStorage.getItem('chengyu-bookmarks'), /畫蛇添足/);

        hooks.setSavedOpen(true);
        hooks.setScriptMode('traditional');
        const savedMarkup = hooks.renderSavedSection();
        assert.match(savedMarkup, /畫蛇添足/);
    });

    it('keeps Anki export split into 10 separate columns', () => {
        const { hooks } = loadFrontendApp();
        const result = {
            chengyu: '一丁不识',
            simplified: '一丁不识',
            traditional: '一丁不識',
            pinyin: 'yi1 ding1 bu4 shi2',
            literal: 'Not know a single character.',
            meaning: 'Illiterate; unable to read.',
            example: '他小时候家里穷，一丁不识。（His family was poor when he was young, so he was illiterate.）',
            tags: ['education', 'ability'],
            formality: 'formal'
        };

        hooks.setScriptMode('traditional');
        const columns = hooks.buildAnkiFieldColumns(result);
        assert.strictEqual(columns.length, 10);
        assert.strictEqual(columns[0], '一丁不識');
        assert.strictEqual(columns[1], '一丁不识');
        assert.strictEqual(columns[2], '一丁不識');

        const lines = hooks.buildAnkiExportContent([result]).split('\n');
        assert.strictEqual(lines[0], '#separator:tab');
        assert.strictEqual(lines[1], '#html:true');
        assert.strictEqual(lines[2].split('\t').length, 10);
    });

    it('does not render an idiom-of-the-day section on the landing page', () => {
        const { hooks, elements } = loadFrontendApp();
        const app = createElement();
        elements.set('app', app);

        hooks.setView('landing');
        hooks.render();

        assert.doesNotMatch(app.innerHTML, /Idiom of the day/i);
        assert.doesNotMatch(app.innerHTML, /今日成语/);
    });

    it('renders a simplified footer with a clear GitHub CTA', () => {
        const { hooks } = loadFrontendApp();
        const markup = hooks.renderFooter();

        assert.match(markup, /View public GitHub/);
        assert.match(markup, /Search Chinese idioms by meaning, characters, or pinyin\./);
        assert.doesNotMatch(markup, /Local embeddings/i);
        assert.doesNotMatch(markup, /learner-first presentation/i);
    });
});

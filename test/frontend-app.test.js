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
        attributes: {},
        classList: {
            add() {},
            remove() {}
        },
        getAttribute(name) {
            return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        removeAttribute(name) {
            delete this.attributes[name];
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

// Optional displayed-DOM model for lifecycle tests. Replacing app.innerHTML
// replaces its controls and drops focus, as a browser does. Assertions read
// mounted controls/text rather than invoking the app's markup generators.
function mountRenderedApp(document, elements) {
    const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"
    })[entity]);
    const textContent = html => decode(html.replace(/<[^>]*>/g, ''));
    let html = '', nodes = [];
    const app = createElement();
    Object.defineProperties(app, {
        textContent: { get: () => textContent(html) },
        innerHTML: {
            get: () => html,
            set(value) {
                html = value;
                if (nodes.includes(document.activeElement)) document.activeElement = document.body;
                for (const node of nodes) if (node.id) elements.delete(node.id);
                nodes = [];
                for (const match of html.matchAll(/<(textarea|button|div)\b([^>]*(?:\bid|\brole)="[^"]+"[^>]*)>([\s\S]*?)<\/\1>/g)) {
                    const attrs = Object.fromEntries([...match[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(m => [m[1], decode(m[2] || '')]));
                    if (!attrs.id && !attrs.role) continue;
                    const node = createElement({ id: attrs.id, role: attrs.role, textContent: textContent(match[3]),
                        value: match[1] === 'textarea' ? decode(match[3]) : '', disabled: 'disabled' in attrs,
                        selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0, scrollLeft: 0,
                        focus() { document.activeElement = this; },
                        setSelectionRange(start, end, direction = 'none') {
                            this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
                        },
                        dispatchEvent(event) { this.listeners[event.type]?.({ ...event, target: this, currentTarget: this }); },
                        click() { if (!this.disabled) this.listeners.click?.({ currentTarget: this, preventDefault() {} }); }
                    });
                    nodes.push(node);
                    if (node.id) elements.set(node.id, node);
                }
            }
        }
    });
    const originalQuerySelector = document.querySelector;
    document.querySelector = selector => selector === '[role="status"]' ? nodes.find(n => n.role === 'status') || null : originalQuerySelector(selector);
    elements.set('app', app);
}

function loadFrontendApp(options = {}) {
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
    const augmentedSource = `${utilsSource}\n${fs.readFileSync(path.join(__dirname, '../public/generated/bookmark-id-migrations.js'), 'utf8')}\n${storageSource}\n${apiSource}\n${ankiSource}\n${bookmarksSource}\n${speechSource}\n${dictionarySource}\n${source}
;globalThis.__APP_TEST_HOOKS__ = {
    bind,
    render,
    renderHeader,
    renderHero,
    playHeroEntranceOnce,
    renderSearchSection,
    renderSavedSection,
    renderFooter,
    renderResultCard,
    renderResultsSection,
    runSearch,
    apiClient: API_CLIENT,
    toggleBookmark,
    formatResultCountLabel,
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
    setSearch: value => { STATE.search = value; },
    setBookmarks: value => { STATE.bookmarks = value; },
    setSavedOpen: value => { STATE.savedOpen = value; }
};`;

    const elements = new Map();
    const localStorageStore = new Map(Object.entries(options.initialLocalStorage || {}));
    const clipboardWrites = [];

    const document = {
        activeElement: null,
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
        querySelectorAll(selector) {
            if (selector === '.hero-character') {
                return options.heroCharacters || [];
            }
            return [];
        },
        createElement() {
            return createElement();
        },
        addEventListener() {}
    };
    if (options.renderedDom) mountRenderedApp(document, elements);

    const localStorage = {
        getItem(key) {
            return localStorageStore.has(key) ? localStorageStore.get(key) : null;
        },
        setItem(key, value) {
            localStorageStore.set(key, String(value));
        }
    };

    const window = {
        ChengyuHeroEntrance: options.heroEntrance,
        location: { origin: 'http://example.test' },
        matchMedia() {
            return { matches: Boolean(options.prefersReducedMotion) };
        },
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
        setTimeout: options.setTimeout || setTimeout,
        clearTimeout,
        AbortController,
        globalThis: null
    };

    sandbox.globalThis = sandbox;

    vm.runInNewContext(augmentedSource, sandbox, { filename: 'public/app.js' });

    return {
        hooks: sandbox.__APP_TEST_HOOKS__,
        document,
        elements,
        localStorage,
        localStorageStore,
        clipboardWrites
    };
}

describe('displayed search DOM regressions', () => {
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((r, j) => { resolve = r; reject = j; });
        return { promise, resolve, reject };
    };
    const json = data => ({ ok: true, json: async () => data });
    const row = { id: 'hosted', chengyu: '一心一意', pinyin: 'yi1 xin1 yi1 yi4', literal: 'one heart', meaning: 'hosted result', tags: [], example: '' };
    function start(fetchImpl, query = '原来的中文描述') {
        const app = loadFrontendApp({ renderedDom: true, fetchImpl,
            setTimeout: (callback, ms) => setTimeout(callback, ms === 700 ? 0 : ms) });
        app.hooks.render();
        const input = app.document.getElementById('search-input');
        input.value = query; input.focus(); input.dispatchEvent({ type: 'input' });
        return { ...app, pending: app.hooks.runSearch(query) };
    }
    function edit(app, query = 'new edited query') {
        const input = app.document.getElementById('search-input');
        input.focus(); input.value = query;
        input.setSelectionRange(2, 6, 'backward'); input.scrollTop = 12; input.scrollLeft = 4;
        input.dispatchEvent({ type: 'input' });
    }
    function assertCancelled(app) {
        const button = app.document.getElementById('search-btn');
        const input = app.document.getElementById('search-input');
        assert.strictEqual(button.disabled, false, 'displayed Search button must be enabled');
        assert.match(button.textContent, /Search/);
        assert.match(app.document.querySelector('[role="status"]').textContent, /Search changed/);
        assert.doesNotMatch(app.elements.get('app').textContent, /Still searching|Searching…|No matching idioms/);
        assert.strictEqual(input.value, 'new edited query');
        assert.strictEqual(app.document.activeElement, input, 'focus must belong to the currently mounted input');
        assert.deepStrictEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 6, 'backward']);
        assert.deepStrictEqual([input.scrollTop, input.scrollLeft], [12, 4]);
    }

    for (const rejectsOnAbort of [true, false]) {
        it(`editing during the initial request repaints enabled Search and preserves focus (${rejectsOnAbort ? 'abort rejection' : 'late response'})`, async () => {
            const initial = deferred(); let signal;
            const app = start((_url, options) => {
                signal = options.signal;
                if (rejectsOnAbort) signal.addEventListener('abort', () => initial.reject(new Error('aborted')));
                return initial.promise;
            });
            assert.strictEqual(app.document.getElementById('search-btn').disabled, true);
            edit(app);
            assert.strictEqual(signal.aborted, true); assertCancelled(app);
            const displayed = app.elements.get('app').innerHTML;
            if (!rejectsOnAbort) initial.resolve(json({ query: 'old query', results: [row] }));
            await app.pending;
            assertCancelled(app);
            assert.strictEqual(app.elements.get('app').innerHTML, displayed, 'aborted work must not replace the cancellation DOM');
        });

        it(`editing during a continuation removes displayed Still searching (${rejectsOnAbort ? 'abort rejection' : 'late response'})`, async () => {
            const continuation = deferred(), polling = deferred(); let signal;
            const app = start((url, options) => {
                if (url.endsWith('/api/search')) return Promise.resolve(json({ query: '原来的中文描述', status: 'pending', results: [], hostedRequestId: 'same' }));
                signal = options.signal;
                if (rejectsOnAbort) signal.addEventListener('abort', () => continuation.reject(new Error('aborted')));
                polling.resolve(); return continuation.promise;
            });
            await polling.promise;
            assert.match(app.document.querySelector('[role="status"]').textContent, /Still searching…/);
            edit(app);
            assert.strictEqual(signal.aborted, true); assertCancelled(app);
            const displayed = app.elements.get('app').innerHTML;
            if (!rejectsOnAbort) continuation.resolve(json({ status: 'complete', embeddingSource: 'hosted-qwen', results: [row] }));
            await app.pending;
            assertCancelled(app); assert.strictEqual(app.elements.get('app').innerHTML, displayed);
        });
    }

    for (const usefulFallback of [false, true]) {
        it(`${usefulFallback ? 'useful' : 'empty'} English fallback stays off screen until the same hosted continuation completes`, async () => {
            const { withHostedSearch } = require('../src/search/hosted-search');
            const { writeQwenIndex, readQwenIndex } = require('../src/embeddings/qwen-index');
            const { normalizePagination } = require('../src/search/search-service');
            const vector = Array(1024).fill(0); vector[0] = 1;
            const index = readQwenIndex(writeQwenIndex([row], [vector], { neurons: 1 }).buffer, [row]);
            let providerCalls = 0;
            const execute = withHostedSearch({ mode: 'auto',
                client: { enabled: true, get: async () => { providerCalls++; return { vector: null, reason: 'timeout', requestId: 'same' }; }, peek: () => ({ vector }) },
                getDatabase: () => [row], getIndex: () => index, isFallbackReady: () => true,
                execute: async () => ({ mode: 'hybrid', results: usefulFallback ? [{ ...row, meaning: 'useful fallback' }] : [] }),
                normalizePagination, createHttpError: (_code, data) => Error(data.error), createResponse: data => ({ ...data, results: [row] }) });
            const continuation = deferred(), polling = deferred(), requests = [];
            const app = start(async (url, options) => {
                requests.push(url);
                const body = JSON.parse(options.body);
                if (url.endsWith('/api/search')) return json(await execute(body.query));
                assert.strictEqual(body.hostedRequestId, 'same'); polling.resolve();
                await continuation.promise;
                return json(await execute(body.query, { statusOnly: true, hostedRequestId: body.hostedRequestId }));
            }, 'on the up and up');
            await polling.promise;
            try {
                assert.doesNotMatch(app.elements.get('app').textContent, /No matching idioms|useful fallback/);
                assert.match(app.document.querySelector('[role="status"]').textContent, /Still searching…/);
            } finally { continuation.resolve(); await app.pending; }
            assert.match(app.elements.get('app').textContent, /hosted result/);
            assert.doesNotMatch(app.elements.get('app').textContent, /Still searching|No matching idioms|useful fallback/);
            assert.strictEqual(providerCalls, 1);
            assert.strictEqual(requests.filter(url => url.endsWith('/api/search')).length, 1);
            assert.strictEqual(app.document.getElementById('search-btn').disabled, false);
        });
    }

    it('opening a view without a search input safely releases its focus', () => {
        const app = loadFrontendApp({ renderedDom: true });
        app.hooks.render();
        app.document.getElementById('search-input').focus();
        app.hooks.setSavedOpen(true);
        assert.doesNotThrow(() => app.hooks.render());
        assert.strictEqual(app.document.getElementById('search-input'), null);
        assert.strictEqual(app.document.activeElement, app.document.body);
    });
});

describe('hosted search lifecycle', () => {
    const row = { id: 'a', chengyu: '一心一意', pinyin: 'yi1 xin1 yi1 yi4', meaning: 'focused', literal: 'one heart', tags: [], example: '' };
    function frontend() {
        const app = loadFrontendApp();
        app.elements.set('app', createElement());
        return app;
    }
    const tick = () => new Promise(setImmediate);

    it('shows Still searching for a cold Chinese query, then renders its completed results', async () => {
        const { hooks } = frontend();
        let finish;
        hooks.apiClient.search = async query => ({ query, status: 'pending', results: [], hostedRequestId: 'original' });
        hooks.apiClient.followHosted = () => new Promise(resolve => { finish = resolve; });
        const pending = hooks.runSearch('经历挫折后依然保持原来的志向');
        await tick();
        assert.match(hooks.renderResultsSection(), /Still searching…/);
        assert.doesNotMatch(hooks.renderResultsSection(), /No matching idioms/);
        finish({ query: '经历挫折后依然保持原来的志向', status: 'complete', embeddingSource: 'hosted-qwen', results: [row] });
        await pending;
        assert.strictEqual(hooks.getState().results[0].id, 'a');
        assert.doesNotMatch(hooks.renderResultsSection(), /Still searching|No matching idioms/);
    });

    // Results that people may already be reading are never replaced: the first
    // page renders once, with either the hosted ranking or the fallback.
    function trackDisplayedRankings(hooks) {
        const shown = [];
        const render = hooks.renderResultsSection;
        return { shown, snapshot() {
            const ids = [...render().matchAll(/<article class="result-card[^"]*" data-result-id="([^"]+)"/g)].map(m => m[1]);
            if (ids.length && shown.at(-1) !== ids.join()) shown.push(ids.join());
        } };
    }

    it('holds English fallback rows back and renders only the hosted first page when it arrives', async () => {
        const { hooks } = frontend();
        let finish, waitMs;
        hooks.apiClient.search = async query => ({ query, status: 'complete', embeddingSource: 'minilm-fallback', results: [{ ...row, id: 'fallback' }], hostedRequestId: 'original', hasMore: true, nextOffset: 10 });
        hooks.apiClient.followHosted = (_q, _initial, options) => { waitMs = options.maxWaitMs; return new Promise(resolve => { finish = resolve; }); };
        const displayed = trackDisplayedRankings(hooks);
        const pending = hooks.runSearch('staying focused despite distractions');
        await tick(); displayed.snapshot();
        assert.match(hooks.renderResultsSection(), /Still searching…/);
        assert.doesNotMatch(hooks.renderResultsSection(), /data-result-id="fallback"/);
        assert.ok(waitMs > 0 && waitMs <= 5000, 'a fallback in hand bounds the hosted wait');
        finish({ query: 'staying focused despite distractions', status: 'complete', embeddingSource: 'hosted-qwen', results: [row] });
        await pending; displayed.snapshot();
        assert.strictEqual(hooks.getState().results[0].id, 'a');
        assert.strictEqual(hooks.getState().search.embeddingSource, 'hosted-qwen');
        assert.deepStrictEqual(displayed.shown, ['a']);
    });

    it('shows the held fallback once when the hosted ranking does not arrive in time', async () => {
        const { hooks } = frontend();
        let finish;
        hooks.apiClient.search = async query => ({ query, status: 'complete', embeddingSource: 'minilm-fallback', results: [{ ...row, id: 'fallback' }], hostedRequestId: 'original', hasMore: true, nextOffset: 10 });
        hooks.apiClient.followHosted = () => new Promise(resolve => { finish = resolve; });
        const displayed = trackDisplayedRankings(hooks);
        const pending = hooks.runSearch('staying focused despite distractions');
        await tick(); displayed.snapshot();
        finish({ status: 'unavailable', message: 'Description search is temporarily unavailable.' });
        await pending; displayed.snapshot();
        assert.deepStrictEqual(displayed.shown, ['fallback']);
        assert.strictEqual(hooks.getState().searchNotice, null, 'a slow hosted ranking is not reported as an outage');
        assert.doesNotMatch(hooks.renderResultsSection(), /Still searching|temporarily unavailable/);
        assert.match(hooks.renderResultsSection(), /id="load-more-btn"(?![^>]*disabled)/);
        assert.strictEqual(hooks.getState().loading, false);
    });

    it('query edits abort continuations and prevent late responses from updating the UI', async () => {
        const { hooks, elements } = frontend();
        const input = createElement(); elements.set('search-input', input);
        let finish, signal;
        hooks.apiClient.search = async query => ({ query, status: 'pending', results: [], hostedRequestId: 'original' });
        hooks.apiClient.followHosted = (_q, _initial, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
        const pending = hooks.runSearch('原来的中文描述'); await tick();
        input.listeners.input({ target: { value: 'new query' } });
        assert.strictEqual(signal.aborted, true);
        finish({ status: 'complete', embeddingSource: 'hosted-qwen', results: [row] });
        await pending;
        assert.strictEqual(hooks.getState().query, 'new query'); assert.strictEqual(hooks.getState().results.length, 0);
        assert.doesNotMatch(hooks.renderResultsSection(), /No matching idioms/);
    });

    it('a newer search wins even if the older initial HTTP response ignores abort', async () => {
        const { hooks } = frontend();
        let old;
        hooks.apiClient.search = query => query === 'old' ? new Promise(resolve => { old = resolve; })
            : Promise.resolve({ query, status: 'complete', results: [row] });
        const pending = hooks.runSearch('old');
        await hooks.runSearch('new');
        old({ query: 'old', results: [] }); await pending;
        assert.strictEqual(hooks.getState().search.query, 'new'); assert.strictEqual(hooks.getState().results.length, 1);
    });

    it('terminal failures show temporary unavailability without a no-matches message', async () => {
        const { hooks } = frontend();
        for (const [query, status] of [['只有困难时才想起早该做的准备', 'unavailable'], ['an English query with no lexical fallback matches', 'complete']]) {
            hooks.apiClient.search = async () => ({ query, status, results: [], message: 'Description search is temporarily unavailable. Try English, an exact idiom, or pinyin.' });
            await hooks.runSearch(query);
            assert.match(hooks.renderResultsSection(), /temporarily unavailable.*English.*exact.*pinyin/);
            assert.doesNotMatch(hooks.renderResultsSection(), /No matching idioms/);
        }
    });

    it('bounds polling, handles cancellation, and never sends a second ordinary search', async () => {
        const paths = [];
        const { hooks } = loadFrontendApp({ fetchImpl: async (url, options) => {
            paths.push(url); assert.strictEqual(JSON.parse(options.body).hostedRequestId, 'same');
            return { ok: true, json: async () => ({ status: 'pending' }) };
        } });
        const result = await hooks.apiClient.followHosted('query', { hostedRequestId: 'same' }, { pollMs: 1, maxWaitMs: 15 });
        assert.strictEqual(result.status, 'unavailable'); assert.ok(paths.length > 0);
        assert.ok(paths.every(url => url.endsWith('/api/search/status')));
        const controller = new AbortController(); controller.abort();
        const count = paths.length;
        await hooks.apiClient.followHosted('query', { hostedRequestId: 'same' }, { signal: controller.signal });
        assert.strictEqual(paths.length, count);
    });

    it('does not concatenate pages from hosted and fallback rankings', async () => {
        const { hooks } = frontend();
        hooks.setResults([row]); hooks.setSearch({ query: 'focused', embeddingSource: 'minilm-fallback', nextOffset: 10 });
        hooks.apiClient.search = async query => ({ query, embeddingSource: 'hosted-qwen', status: 'complete', results: [{ ...row, id: 'different' }], offset: 10 });
        await hooks.runSearch('focused', { append: true });
        assert.strictEqual(hooks.getState().results.length, 1); assert.strictEqual(hooks.getState().results[0].id, 'a');
        assert.match(hooks.getState().searchNotice, /Search again/);
    });
});

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

    it('renders hero and header UI copy in the selected script', () => {
        const { hooks } = loadFrontendApp();

        hooks.setScriptMode('simplified');
        const simplifiedHero = hooks.renderHero();
        assert.match(hooks.renderHeader(), /成语搜索/);
        assert.match(simplifiedHero, />语<\/span>/);
        assert.match(simplifiedHero, /There’s a four-character phrase for that\./);
        assert.match(simplifiedHero, /hero-pinyin">chéng/);
        assert.doesNotMatch(simplifiedHero, /Meaning.*中文.*Pinyin/);
        assert.doesNotMatch(hooks.renderHeader(), /成語搜索/);

        hooks.setScriptMode('traditional');
        const traditionalHero = hooks.renderHero();
        assert.match(hooks.renderHeader(), /成語搜索/);
        assert.match(traditionalHero, />語<\/span>/);
        assert.match(traditionalHero, /There’s a four-character phrase for that\./);
        assert.match(traditionalHero, /aria-label="成語搜索"/);
        assert.doesNotMatch(traditionalHero, /Meaning.*中文.*Pinyin/);
        assert.doesNotMatch(hooks.renderHeader(), /成语搜索/);
    });

    function runIndexHeroEntrance({ characters, prefersReducedMotion = false, now = 1234 }) {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(code => code.includes('ChengyuHeroEntrance'));
        assert.ok(script, 'index.html starts the hero entrance inline, before first paint');
        const window = { matchMedia: () => ({ matches: prefersReducedMotion }) };
        const document = { timeline: { currentTime: now }, querySelectorAll: selector => (selector === '.hero-character' ? characters() : []) };
        vm.runInNewContext(script, { window, document });
        return window.ChengyuHeroEntrance;
    }
    const animatedCharacters = calls => () => Array.from({ length: 4 }, () => ({
        animate(keyframes, options) { const animation = { keyframes, options, startTime: null }; calls.push(animation); return animation; }
    }));

    it('starts the hero entrance on the prerendered page without transforms or persistent fill', () => {
        const calls = [];
        runIndexHeroEntrance({ characters: animatedCharacters(calls), now: 1234 });

        assert.strictEqual(calls.length, 4);
        assert.strictEqual(calls[0].keyframes[0].opacity, 0);
        assert.strictEqual(calls[0].keyframes[1].opacity, 1);
        assert.ok(calls[0].keyframes.every(frame => !('transform' in frame)));
        assert.strictEqual(calls[0].options.delay, 0);
        assert.strictEqual(calls[3].options.delay, 165);
        assert.strictEqual(calls[0].options.fill, 'backwards');
        assert.ok(calls.every(call => call.startTime === 1234));
    });

    it('continues the same entrance on replaced characters instead of restarting it', () => {
        const calls = [];
        const entrance = runIndexHeroEntrance({ characters: animatedCharacters(calls), now: 1234 });
        entrance.play();
        assert.strictEqual(calls.length, 8);
        assert.ok(calls.every(call => call.startTime === 1234), 'replacement characters share the original start time');
    });

    it('skips the hero entrance when reduced motion is preferred', () => {
        const calls = [];
        const entrance = runIndexHeroEntrance({ characters: animatedCharacters(calls), prefersReducedMotion: true });
        entrance.play();
        assert.strictEqual(calls.length, 0);
    });

    it('app.js continues the entrance once, only when the first render replaces the hero', () => {
        let plays = 0;
        const { hooks } = loadFrontendApp({ heroCharacters: [{}], heroEntrance: { play() { plays += 1; } } });
        hooks.playHeroEntranceOnce();
        hooks.playHeroEntranceOnce();
        assert.strictEqual(plays, 1);
    });

    it('renders landing example glosses in the selected script', () => {
        const { hooks } = loadFrontendApp();
        hooks.setView('landing');

        hooks.setScriptMode('simplified');
        const simplifiedMarkup = hooks.renderSearchSection();
        assert.match(simplifiedMarkup, /画蛇添足/);
        assert.match(simplifiedMarkup, /Need a spark\?/);
        assert.match(simplifiedMarkup, /aria-label="Search for: It was already done, then I added something extra and ruined it — 画蛇添足"/);
        assert.strictEqual((simplifiedMarkup.match(/class="chip"/g) || []).length, 6);
        // A card's visible text is exactly the query it runs.
        for (const [, query, label] of simplifiedMarkup.matchAll(/data-query="([^"]+)"[\s\S]*?<span class="chip-label">([^<]+)<\/span>/g)) {
            assert.strictEqual(label, query);
        }
        assert.doesNotMatch(simplifiedMarkup, /畫蛇添足/);

        hooks.setScriptMode('traditional');
        const traditionalMarkup = hooks.renderSearchSection();
        assert.match(traditionalMarkup, /aria-label="Search for: It was already done, then I added something extra and ruined it — 畫蛇添足"/);
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
        const button = createElement({ innerHTML: 'Copy', attributes: { 'aria-label': 'Copy idiom' } });
        await hooks.copyResult(result, button);
        assert.strictEqual(clipboardWrites.at(-1), '画蛇添足');
        // The icon-sized button confirms with a check, not a word that overflows it.
        assert.strictEqual(button.getAttribute('aria-label'), 'Copied');
        assert.match(button.innerHTML, /<svg[\s\S]*role="status">Copied</);

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

        hooks.setScriptMode('traditional');
        const savedMarkup = hooks.renderSavedSection();
        assert.match(savedMarkup, /data-result-id="chengyu_second"/);
        assert.match(savedMarkup, /Saved idioms <span>· 已存成語<\/span>/);

        const resultMarkup = hooks.renderResultCard(first, 0);
        assert.match(resultMarkup, /data-result-id="chengyu_first"/);

        assert.strictEqual(hooks.findResultByPublicId('chengyu_second', '难兄难弟').pinyin, 'nan4 xiong1 nan4 di4');
        assert.strictEqual(hooks.findResultByPublicId('', '难兄难弟').pinyin, 'nan2 xiong1 nan2 di4');
    });

    it('saves an idiom without navigating away from search results', () => {
        const { hooks, elements } = loadFrontendApp();
        const result = {
            id: 'chengyu_only',
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add legs',
            meaning: 'to ruin something by overdoing it',
            tags: [],
            formality: 'formal'
        };

        elements.set('app', createElement());
        hooks.setBookmarks({});
        hooks.setSavedOpen(false);
        hooks.toggleBookmark(result);

        assert.strictEqual(hooks.getState().savedOpen, false);
        assert.strictEqual(hooks.getState().bookmarks[result.id].chengyu, result.chengyu);
    });

    it('returns to search when the final saved idiom is removed', () => {
        const { hooks, elements } = loadFrontendApp();
        const result = {
            id: 'chengyu_only',
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add legs',
            meaning: 'to ruin something by overdoing it',
            tags: [],
            formality: 'formal'
        };

        elements.set('app', createElement());
        hooks.setBookmarks({ [result.id]: result });
        hooks.setSavedOpen(true);
        hooks.toggleBookmark(result);

        assert.strictEqual(hooks.getState().savedOpen, false);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks), []);
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

    it('renders a compact footer with a source-code link', () => {
        const { hooks } = loadFrontendApp();
        const markup = hooks.renderFooter();

        assert.match(markup, /Source code/);
        assert.match(markup, /Chengyu Search/);
        assert.doesNotMatch(markup, /Search Chinese idioms by meaning, characters, or pinyin\./);
        assert.doesNotMatch(markup, /View public GitHub/);
    });

    it('distinguishes loaded results from the total when pagination continues', () => {
        const { hooks } = loadFrontendApp();

        hooks.setSearch({ loadedCount: 10, hasMore: true });
        assert.strictEqual(hooks.formatResultCountLabel(), '10+ idioms');

        hooks.setSearch({ loadedCount: 10, hasMore: false });
        assert.strictEqual(hooks.formatResultCountLabel(), '10 idioms');

        hooks.setSearch({ loadedCount: 1, hasMore: false });
        assert.strictEqual(hooks.formatResultCountLabel(), '1 idiom');
    });

    it('expands the first result and renders later results as compact rows with a details disclosure', () => {
        const { hooks } = loadFrontendApp();
        const result = {
            chengyu: '画蛇添足',
            simplified: '画蛇添足',
            traditional: '畫蛇添足',
            pinyin: 'hua4 she2 tian1 zu2',
            literal: 'draw snake add legs',
            meaning: 'to ruin something by overdoing it',
            example: '别再画蛇添足了。（Do not overdo it.）',
            tags: ['warning'],
            formality: 'formal'
        };

        const primary = hooks.renderResultCard(result, 0);
        assert.match(primary, /class="result-card rank-1"/);
        assert.match(primary, /class="result-body hero-body"/);
        assert.doesNotMatch(primary, /class="pinyin-line"/);
        // The idiomatic meaning leads; the literal gloss is a secondary "lit." line.
        assert.match(primary, /class="result-meaning">to ruin something by overdoing it</);
        assert.match(primary, /class="literal-line"><span class="lit-label">lit\.<\/span>/);
        assert.ok(primary.indexOf('result-meaning') < primary.indexOf('literal-line'));
        assert.match(primary, /class="example-zh"/);
        // The first result's example is always open, at every width, never
        // behind the hidden attribute, its translation in full. Its tags
        // follow the example; on phones an inline "Tags" disclosure right
        // after the example (CSS shows it only there) holds them. Its other
        // script sits with its other forms, under the lit. gloss.
        assert.match(primary, /class="result-body hero-body" id="result-details-1">/);
        assert.match(primary, /class="hero-extra" id="result-extra-1"><div class="tags-row">/);
        assert.match(primary, /<span class="variant-label-zh" lang="zh-Hans">繁體<\/span> Traditional<\/span> <span class="variant-forms"><span class="variant-script" lang="zh-Hant">/);
        assert.ok(primary.indexOf('literal-line') < primary.indexOf('variant-line'));
        assert.match(primary, /<span class="hero-more-label">Tags<\/span>/);
        assert.ok(primary.indexOf('hero-body') < primary.indexOf('example-en'));
        assert.ok(primary.indexOf('example-en') < primary.indexOf('hero-extra'));
        assert.match(primary, /<button type="button" class="hero-more" data-action="toggle-details"[^>]*aria-expanded="false" aria-controls="result-extra-1"/);
        assert.ok(primary.indexOf('example-en') < primary.indexOf('hero-more'));
        assert.ok(primary.indexOf('hero-more') < primary.indexOf('class="hero-extra"'));
        assert.doesNotMatch(primary, / hidden[ >]/);

        const secondary = hooks.renderResultCard(result, 1);
        assert.match(secondary, /class="result-card result-row"/);
        assert.match(secondary, /class="result-meaning"/);
        // A row's disclosure is a one-line preview of its example sentence.
        assert.match(secondary, /<button type="button" class="example-preview" data-action="toggle-details"[^>]*aria-expanded="false" aria-controls="result-details-2"/);
        assert.match(secondary, /class="preview-zh"[^>]*>别再<span class="highlight">画蛇添足<\/span>了。</);
        assert.match(secondary, /class="result-body result-details" id="result-details-2" hidden>/);
        assert.match(secondary, /class="example-zh"/);
        assert.doesNotMatch(secondary, /<details/);
        assert.doesNotMatch(secondary, /class="pinyin-line"/);

        hooks.getState().expandedResults.add(result.chengyu);
        const expanded = hooks.renderResultCard(result, 1);
        assert.match(expanded, /result-row is-expanded/);
        assert.match(expanded, /aria-expanded="true"/);
        assert.doesNotMatch(expanded, /id="result-details-2" hidden/);
    });

    it('frames the results header by response: exact match, closest idioms, or a match count', () => {
        const { hooks } = loadFrontendApp();
        const base = { pinyin: 'hua4 she2 tian1 zu2', literal: 'x', meaning: 'y', example: '', tags: [] };
        const rows = [
            { ...base, id: 'a', chengyu: '画蛇添足', relevance_score: 100 },
            { ...base, id: 'b', chengyu: '田忌赛马', relevance_score: 31 }
        ];
        hooks.setView('results');
        hooks.setResults(rows);
        hooks.setSearch({ query: 'hua she tian zu', queryType: 'pinyin', loadedCount: 2, hasMore: false });
        const exact = hooks.renderResultsSection();
        assert.match(exact, /<span class="count">Exact match<\/span><span class="results-for"> for <span class="results-query">&ldquo;hua she tian zu&rdquo;/);
        // The other idioms are not matches: an exact-match page shows only the
        // match (plus its own similar-meaning chips), with no other rows and
        // no paging.
        assert.match(exact, /class="result-card rank-1"/);
        assert.doesNotMatch(exact, /田忌赛马|More idioms|other-results|load-more/);

        hooks.setResults([rows[0], ...['c', 'd', 'e', 'f', 'g'].map(id => ({ ...rows[1], id }))]);
        hooks.setSearch({ query: 'hua she tian zu', queryType: 'pinyin', loadedCount: 6, hasMore: true });
        const many = hooks.renderResultsSection();
        assert.strictEqual((many.match(/class="result-card result-row/g) || []).length, 0);
        assert.doesNotMatch(many, /load-more/);
        hooks.setResults(rows);

        hooks.setSearch({ query: 'drawing a snake', mode: 'semantic', queryType: 'english_meaning', loadedCount: 2, hasMore: true });
        const semantic = hooks.renderResultsSection();
        assert.match(semantic, /<span class="count">Closest idioms<\/span><span class="results-for"> for /);
        assert.doesNotMatch(semantic, /Exact match|Other idioms|\d+\+? idioms/);
        assert.match(semantic, /Show more close idioms/);

        hooks.setSearch({ query: 'snake', mode: 'hybrid', queryType: 'partial', loadedCount: 2, hasMore: false });
        const keyword = hooks.renderResultsSection();
        assert.match(keyword, /<span class="count">2 idioms<\/span><span class="results-for"> matching /);
        assert.doesNotMatch(keyword, /Exact match|Other idioms/);
    });

    it('leads a weak meaning search with a no-close-match block and keeps its guesses collapsed', () => {
        const { hooks } = loadFrontendApp();
        const base = { pinyin: 'luo4 huang1 er2 tao2', literal: 'x', meaning: 'y', example: '例句。（An example.）', tags: ['t'] };
        hooks.setView('results');
        hooks.setResults([
            { ...base, id: 'a', chengyu: '落荒而逃', relevance_score: 41 },
            { ...base, id: 'b', chengyu: '俯仰之间', relevance_score: 39 }
        ]);
        const semantic = { query: 'qwzxv blorft', mode: 'semantic', queryType: 'english_meaning', loadedCount: 2, hasMore: false };

        hooks.setSearch({ ...semantic, matchStrength: 'weak' });
        const weak = hooks.renderResultsSection();
        assert.match(weak, /<h2 class="weak-title">No close match<span class="results-for"> for <span class="results-query">&ldquo;qwzxv blorft&rdquo;<\/span><\/span><\/h2>/);
        assert.doesNotMatch(weak, /Closest idioms/);
        assert.match(weak, /class="weak-hint"[\s\S]*Try describing the situation or feeling, or type the pinyin\./);
        // The landing's six spark cards fill the page below the collapsed guesses.
        assert.strictEqual((weak.match(/class="chip" type="button" data-query=/g) || []).length, 6);
        assert.match(weak, /class="results-sparks">[\s\S]*Need a spark\?/);
        assert.ok(weak.indexOf('loose-toggle') < weak.indexOf('results-sparks'));
        // The guesses are collapsed behind one disclosure; none is featured.
        assert.match(weak, /class="reveal-toggle" id="loose-toggle" data-action="toggle-reveal" aria-expanded="false" aria-controls="loose-results">\s*<span>Show 2 loose guesses<\/span>/);
        assert.match(weak, /class="results-grid is-weak" id="loose-results" hidden>/);
        assert.doesNotMatch(weak, /rank-1|hero-body/);
        assert.strictEqual((weak.match(/class="result-card result-row/g) || []).length, 2);
        assert.match(weak, /class="rank-badge">01</);
        hooks.getState().revealed.add('loose');
        const opened = hooks.renderResultsSection();
        assert.match(opened, /aria-expanded="true" aria-controls="loose-results">\s*<span>Hide loose guesses<\/span>/);
        assert.match(opened, /id="loose-results">/);
        assert.doesNotMatch(opened, /results-sparks/);
        hooks.getState().revealed.clear();

        for (const matchStrength of [undefined, 'normal']) {
            hooks.setSearch({ ...semantic, matchStrength });
            const normal = hooks.renderResultsSection();
            assert.match(normal, /<span class="count">Closest idioms<\/span><span class="results-for"> for /);
            assert.doesNotMatch(normal, /No close match|weak-hint|results-sparks|loose-toggle/);
            assert.match(normal, /class="result-card rank-1"/);
            assert.match(normal, /class="result-body hero-body"/);
            assert.strictEqual((normal.match(/class="result-card result-row/g) || []).length, 1);
        }

        // The flag only applies to meaning search.
        hooks.setSearch({ ...semantic, mode: 'hybrid', matchStrength: 'weak' });
        assert.doesNotMatch(hooks.renderResultsSection(), /No close match|weak-hint/);
    });

    it('keeps a weak response flag on the search state for the first page', async () => {
        const { hooks } = loadFrontendApp({
            renderedDom: true,
            fetchImpl: async url => ({ ok: true, async json() {
                return String(url).endsWith('/api/search')
                    ? { query: 'qwzxv blorft', mode: 'semantic', queryType: 'english_meaning', matchStrength: 'weak', offset: 0, hasMore: false,
                        results: [{ id: 'a', chengyu: '落荒而逃', pinyin: 'luo4 huang1 er2 tao2', meaning: 'to flee', literal: 'x', tags: [], example: '' }] }
                    : { status: 'ok', database: true };
            } })
        });
        await hooks.runSearch('qwzxv blorft');
        assert.strictEqual(hooks.getState().search.matchStrength, 'weak');
        assert.match(hooks.renderResultsSection(), /No close match/);
    });

    it('shows the first two senses of a compact row and keeps the rest behind its disclosure', () => {
        const { hooks } = loadFrontendApp();
        const result = { id: 'a', chengyu: '一蹶不振', pinyin: 'yi1 jue2 bu4 zhen4', literal: 'one fall not rise',
            meaning: 'one stumble, unable to rise; a setback leading to total collapse; ruined at a stroke', example: '例句。', tags: [] };
        const row = hooks.renderResultCard(result, 1);
        assert.match(row, /class="result-meaning">one stumble, unable to rise; a setback leading to total collapse<span class="meaning-more">; ruined at a stroke<\/span><\/p>/);
        // Without a disclosure there is nowhere to keep extra senses, so the full gloss shows.
        const bare = hooks.renderResultCard({ ...result, example: '', tags: [] }, 1);
        assert.match(bare, /class="result-meaning">one stumble, unable to rise; a setback leading to total collapse; ruined at a stroke<\/p>/);
    });

    it('lists the other forms the server folded into a result, each searching itself', () => {
        const { hooks } = loadFrontendApp();
        const form = (simplified, traditional, relation) => ({ simplified, traditional, pinyin: 'sai4 weng1', publicId: simplified, relation });
        const result = { id: 'swsm', chengyu: '塞翁失马', simplified: '塞翁失马', traditional: '塞翁失馬', pinyin: 'sai4 weng1 shi1 ma3',
            meaning: 'a blessing in disguise', literal: 'frontier old man loses horse', example: '例句。', tags: [],
            variants: [form('北叟失马', '北叟失馬', 'same'), form('塞翁失马安知非福', '塞翁失馬安知非福', 'full_form'),
                form('塞翁失马焉知非福', '塞翁失馬焉知非福', 'full_form'), form('塞翁失马焉知祸福', '塞翁失馬焉知禍福', 'full_form')] };

        hooks.setScriptMode('simplified');
        const row = hooks.renderResultCard(result, 1);
        assert.match(row, /<span class="variant-label"><span class="variant-label-zh" lang="zh-Hans">也作<\/span> Also written<\/span> <span class="variant-forms"><span class="variant-item"><button type="button" class="variant-form" lang="zh-Hans" data-similar-query="北叟失马"[^>]*>北叟失马<\/button><\/span>/);
        // Forms are whole units with no separator, so a wrap can't strand a dot.
        assert.doesNotMatch(row.slice(row.indexOf("variant-line"), row.indexOf("</p>", row.indexOf("variant-line"))), /variant-sep|·/);
        // A row is not the first result: no other-script line, and pinyin only as a tooltip.
        assert.doesNotMatch(row, /variant-script|variant-pin/);
        assert.match(row, /data-similar-query="北叟失马"[^>]* title="[^"]+">北叟失马<\/button>/);
        // A longer full_form is the full saying; rows show three forms and count the rest.
        assert.match(row, /全句<\/span> Full saying<\/span>/);
        assert.strictEqual((row.match(/class="variant-form"/g) || []).length, 3);
        // The rest wait on the idiom's own page, which the count links to.
        assert.match(row, /<button type="button" class="variant-more" data-similar-query="塞翁失马" aria-label="See all 4 forms of 塞翁失马">\+1 more form<\/button>/);

        // An exact match lists every form.
        const exact = hooks.renderResultCard(result, 0, { exact: true });
        assert.strictEqual((exact.match(/class="variant-form"/g) || []).length, 4);
        assert.doesNotMatch(exact, /variant-more/);
        // An exact match gives each form its pinyin.
        assert.strictEqual((exact.match(/class="variant-pin"/g) || []).length, 4);
        // The family's usual form says so, on screen and to screen readers, before its pinyin.
        const typedVariant = hooks.renderResultCard({ ...result, variants: [{ ...form('塞翁失马', '塞翁失馬', 'same'), preferred: true }] }, 0, { exact: true });
        assert.match(typedVariant, /aria-label="Search for 塞翁失马 \([^)]+\), the more common form">塞翁失马<\/button><span class="variant-common">more common<\/span><span class="variant-pin">[^<]+<\/span>/);
        // The first result of a meaning search also gives each form its pinyin, with no space before punctuation.
        const lead = hooks.renderResultCard({ ...result, variants: [{ ...form('百花齐放，百家争鸣', '百花齊放，百家爭鳴', 'full_form'), pinyin: 'bai3 hua1 , bai3 jia1' }] }, 0);
        assert.match(lead, /<span class="variant-pin">[^<,]*[^ ], [^<]+<\/span>/);
        // A short form or full saying is listed in its usual spelling only; a rarer one is a click away.
        const spellings = hooks.renderResultCard({ ...result, variants: [{ ...form('塞翁失马焉知非福', '塞翁失馬焉知非福', 'full_form'), common: true },
            { ...form('塞翁失马安知非福', '塞翁失馬安知非福', 'full_form'), common: false }, { ...form('北叟失马', '北叟失馬', 'same'), common: false }] }, 1);
        assert.match(spellings, />塞翁失马焉知非福</);
        assert.doesNotMatch(spellings, /塞翁失马安知非福/);
        assert.match(spellings, />北叟失马</);

        // Traditional mode shows traditional forms but still searches the simplified one.
        hooks.setScriptMode('traditional');
        const trad = hooks.renderResultCard(result, 1);
        assert.match(trad, /data-similar-query="北叟失马"[^>]*>北叟失馬<\/button>/);

        // The short half of a couplet is its short form.
        hooks.setScriptMode('simplified');
        const couplet = { ...result, chengyu: '百花齐放，百家争鸣', simplified: '百花齐放，百家争鸣', variants: [form('百花齐放', '百花齊放', 'full_form')] };
        assert.match(hooks.renderResultCard(couplet, 1), /略作<\/span> Short form<\/span>/);

        // No variants, no line.
        assert.doesNotMatch(hooks.renderResultCard({ ...result, variants: [] }, 1), /variant-line/);
        assert.doesNotMatch(hooks.renderResultCard({ ...result, variants: undefined }, 1), /variant-line/);
    });
});

describe('persistent bookmark migration',()=>{
    const current=require('../chengyuData').find(r=>r.chengyu==='画蛇添足');
    const {buildLegacyChengyuId}=require('../src/data/chengyu-identity');
    const old={...current,meaning:'to ruin the effect by adding something superfluous to overdo it'};
    old.id=buildLegacyChengyuId(old);
    it('migrates the complete historical 画蛇添足 save before first paint and refreshes its content',async()=>{
        assert.notStrictEqual(old.id,current.id);
        const {hooks,elements,localStorage}=loadFrontendApp({initialLocalStorage:{'chengyu-bookmarks':JSON.stringify({[old.id]:old})},fetchImpl:async()=>({ok:true,json:async()=>({results:[current]})})});
        elements.set('app',createElement());hooks.setResults([current]);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[current.id]);
        assert.ok(hooks.renderResultCard(current,0).includes('save-action active'));
        await hooks.refreshBookmarksIfNeeded();
        assert.strictEqual(hooks.getState().bookmarks[current.id].meaning,current.meaning);
        assert.strictEqual(await hooks.refreshBookmarksIfNeeded(),false);
        assert.ok(!localStorage.getItem('chengyu-bookmarks').includes(old.id));
        hooks.toggleBookmark(current);assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[]);
        hooks.toggleBookmark(current);assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[current.id]);
    });
    it('collapses historical/current duplicates in either storage order',()=>{
        for(const entries of [[[old.id,old],[current.id,current]],[[current.id,current],[old.id,old]]]){
            const {hooks}=loadFrontendApp({initialLocalStorage:{'chengyu-bookmarks':JSON.stringify(Object.fromEntries(entries))}});
            assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[current.id]);
            assert.strictEqual(hooks.getState().bookmarks[current.id].meaning,current.meaning);
        }
    });
    it('preserves and refreshes distinct same-headword/same-pinyin senses by ID',async()=>{
        const senses=require('../chengyuData').filter(r=>r.chengyu==='一目了然');
        const vm=require('node:vm'),window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/generated/bookmark-id-migrations.js'),'utf8'),{window});
        const inverse=Object.fromEntries(Object.entries(window.ChengyuBookmarkIdMigrations.aliases).map(([a,b])=>[b,a]));
        const saved=Object.fromEntries(senses.map(r=>{const id=inverse[r.id]||r.id;return [id,{...r,id,meaning:'old sense '+r.id}];}));
        const {hooks}=loadFrontendApp({initialLocalStorage:{'chengyu-bookmarks':JSON.stringify(saved)},fetchImpl:async()=>({ok:true,json:async()=>({results:senses})})});
        await hooks.refreshBookmarksIfNeeded();
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks).sort(),senses.map(r=>r.id).sort());
        for(const r of senses)assert.strictEqual(hooks.getState().bookmarks[r.id].example,r.example);
    });
    it('does not substitute the first same-headword sense for an unknown saved ID',async()=>{
        const unknown={...current,id:'chengyu_unknown_sense'};
        const {hooks}=loadFrontendApp({initialLocalStorage:{'chengyu-bookmarks':JSON.stringify({[unknown.id]:unknown})},fetchImpl:async()=>({ok:true,json:async()=>({results:[current]})})});
        assert.strictEqual(await hooks.refreshBookmarksIfNeeded(),false);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[unknown.id]);
    });
    it('does not resurrect a migrated save removed while its refresh is pending',async()=>{
        let resolve;const pending=new Promise(r=>{resolve=r;});
        const {hooks,elements}=loadFrontendApp({initialLocalStorage:{'chengyu-bookmarks':JSON.stringify({[old.id]:old})},fetchImpl:()=>pending});
        elements.set('app',createElement());const refresh=hooks.refreshBookmarksIfNeeded();hooks.toggleBookmark(current);
        resolve({ok:true,json:async()=>({results:[current]})});await refresh;
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks),[]);
    });
});


describe('partial and unresolved bookmark identity', () => {
    const senses = require('../chengyuData').filter(r => r.chengyu === '一目了然');
    it('restores both sense IDs from storage keys before paint and refresh', async () => {
        assert.strictEqual(senses.length, 2);
        const saved = Object.fromEntries(senses.map(({id, ...record}) => [id, {...record, meaning: 'old', example: ''}]));
        const {hooks, elements, localStorage} = loadFrontendApp({initialLocalStorage: {'chengyu-bookmarks': JSON.stringify(saved)}, fetchImpl: async () => ({ok: true, json: async () => ({results: senses})})});
        elements.set('app', createElement());
        for (const r of senses) {
            assert.strictEqual(hooks.getState().bookmarks[r.id].id, r.id);
            assert.ok(hooks.renderResultCard(r, 0).includes('save-action active'));
        }
        await hooks.refreshBookmarksIfNeeded();
        for (const r of senses) assert.strictEqual(hooks.getState().bookmarks[r.id].meaning, r.meaning);
        const persisted = JSON.parse(localStorage.getItem('chengyu-bookmarks'));
        for (const r of senses) assert.strictEqual(persisted[r.id].id, r.id);
        hooks.toggleBookmark(senses[0]);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks), [senses[1].id]);
        hooks.toggleBookmark(senses[1]);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks), []);
    });
    it('keeps ambiguous legacy 一目了然 separate from both same-pinyin senses and their toggles', async () => {
        assert.strictEqual(senses[0].pinyin, senses[1].pinyin);
        const legacy = {chengyu: '一目了然', pinyin: senses[0].pinyin, meaning: 'unresolved old sense'};
        const {hooks, elements, localStorage} = loadFrontendApp({initialLocalStorage: {'chengyu-bookmarks': JSON.stringify({'一目了然': legacy})}, fetchImpl: async () => ({ok: true, json: async () => ({results: senses})})});
        elements.set('app', createElement());
        assert.strictEqual(await hooks.refreshBookmarksIfNeeded(), false);
        for (const r of senses) {
            assert.ok(!hooks.renderResultCard(r, 0).includes('save-action active'));
            hooks.toggleBookmark(r);
            assert.strictEqual(hooks.getState().bookmarks['一目了然'].meaning, legacy.meaning);
            assert.ok(hooks.getState().bookmarks[r.id]);
            hooks.toggleBookmark(r);
            assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks), ['一目了然']);
        }
        assert.strictEqual(JSON.parse(localStorage.getItem('chengyu-bookmarks'))['一目了然'].meaning, legacy.meaning);
        // The unresolved saved card itself still has a working remove action.
        hooks.toggleBookmark(hooks.getState().bookmarks['一目了然']);
        assert.deepStrictEqual(Object.keys(hooks.getState().bookmarks), []);
    });
});

describe('prerendered landing page', () => {
    const { buildIndexHtml, renderLandingShell } = require('../scripts/build-landing-shell');
    const shellInner = () => renderLandingShell().replace(/^<div class="app" id="app">/, '').replace(/<\/div>$/, '');

    it('public/index.html contains the current landing render (npm run build:landing)', () => {
        const current = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        assert.strictEqual(buildIndexHtml(current), current);
    });

    function mountShell(initialLocalStorage = {}) {
        let plays = 0;
        const app = loadFrontendApp({ initialLocalStorage, heroCharacters: [{}], heroEntrance: { play() { plays += 1; } } });
        let writes = 0, html = shellInner();
        const root = createElement();
        Object.defineProperty(root, 'innerHTML', { get: () => html, set(value) { writes += 1; html = value; } });
        const searchButton = createElement();
        app.elements.set('app', root);
        app.elements.set('search-btn', searchButton);
        app.hooks.render();
        return { ...app, writes: () => writes, plays: () => plays, searchButton };
    }

    for (const [label, storage] of [['a first visit', {}], ['a saved dark theme', { 'chengyu-theme': 'dark' }]]) {
        it(`keeps the prerendered DOM and attaches handlers for ${label}`, () => {
            const app = mountShell(storage);
            assert.strictEqual(app.writes(), 0, 'nothing pops in over the first paint');
            assert.strictEqual(typeof app.searchButton.listeners.click, 'function');
            assert.strictEqual(app.plays(), 0, 'the inline entrance is already running');
            app.hooks.render();
            assert.strictEqual(app.writes(), 0, 'an unchanged page is not rebuilt');
        });
    }

    it('replaces the shell for a saved traditional preference and continues the entrance', () => {
        const app = mountShell({ 'chengyu-script-mode': 'traditional' });
        assert.strictEqual(app.writes(), 1);
        assert.match(app.elements.get('app').innerHTML, /成語搜索/);
        assert.strictEqual(app.plays(), 1);
    });
});

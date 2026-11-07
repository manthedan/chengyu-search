const PAGE_SIZE = 10;
const PUBLIC_GITHUB_URL = 'https://github.com/manthedan/chengyu-search';
// How long a first page waits for the hosted ranking after the server has
// already waited for it. With fallback rows in hand, the wait is short and the
// fallback is shown if it expires; without them there is nothing to show yet.
const HOSTED_WAIT_WITH_FALLBACK_MS = 3500;
const HOSTED_WAIT_WITHOUT_FALLBACK_MS = 10000;

// Landing example cards. Each card shows its query verbatim and must return
// its idiom first. Check with: npm run audit:examples -- --url <server>
const EXAMPLE_QUERIES = [
    {
        query: 'It was already done, then I added something extra and ruined it',
        simplified: '画蛇添足',
        pinyin: 'huà shé tiān zú',
        traditional: '畫蛇添足'
    },
    {
        query: 'Pretending to be dumb to avoid answering',
        simplified: '装傻充愣',
        pinyin: 'zhuāng shǎ chōng lèng',
        traditional: '裝傻充愣'
    },
    {
        query: 'A clever and quick-witted child',
        simplified: '聪明伶俐',
        pinyin: 'cōng míng líng lì',
        traditional: '聰明伶俐'
    },
    {
        query: 'Hesitant and unable to move forward',
        simplified: '趑趄不前',
        pinyin: 'zī jū bù qián',
        traditional: '趑趄不前'
    },
    {
        query: 'It sounded easier than it was',
        simplified: '谈何容易',
        pinyin: 'tán hé róng yì',
        traditional: '談何容易'
    },
    {
        query: 'Better late than never: fixing things after a loss',
        simplified: '亡羊补牢',
        pinyin: 'wáng yáng bǔ láo',
        traditional: '亡羊補牢'
    }
];

const FRONTEND_UTILS = window.ChengyuFrontendUtils;
if (!FRONTEND_UTILS) {
    throw new Error('frontend-utils.js must load before app.js');
}
const {
    createEmptySearchState,
    normalizeBookmarkRecord,
    escapeHtml,
    escapeRegExp,
    toneMarkPinyinString,
    extractToneMarkedPinyinSyllables,
    containsChineseCharacter,
    buildCharacterPins,
    splitExampleText,
    splitMeaningNote
} = FRONTEND_UTILS;

const FRONTEND_STORAGE_FACTORY = window.ChengyuFrontendStorage;
if (!FRONTEND_STORAGE_FACTORY) {
    throw new Error('frontend-storage.js must load before app.js');
}
const STORAGE = FRONTEND_STORAGE_FACTORY.createFrontendStorage({ normalizeBookmarkRecord });

const FRONTEND_API_FACTORY = window.ChengyuFrontendApi;
if (!FRONTEND_API_FACTORY) {
    throw new Error('frontend-api.js must load before app.js');
}
const API_CLIENT = FRONTEND_API_FACTORY.createChengyuApiClient({
    baseUrl: window.location.origin,
    pageSize: PAGE_SIZE
});

const FRONTEND_ANKI_FACTORY = window.ChengyuFrontendAnki;
if (!FRONTEND_ANKI_FACTORY) {
    throw new Error('frontend-anki.js must load before app.js');
}
const ANKI = FRONTEND_ANKI_FACTORY.createAnkiExporter({
    escapeHtml,
    toneMarkPinyinString,
    getDisplayHeadword
});
const buildAnkiFieldColumns = ANKI.buildAnkiFieldColumns;
const buildAnkiExportContent = ANKI.buildAnkiExportContent;

const FRONTEND_BOOKMARKS_FACTORY = window.ChengyuFrontendBookmarks;
if (!FRONTEND_BOOKMARKS_FACTORY) {
    throw new Error('frontend-bookmarks.js must load before app.js');
}
const BOOKMARKS = FRONTEND_BOOKMARKS_FACTORY.createBookmarkHelpers({
    normalizeBookmarkRecord,
    getResultPublicId,
    storage: STORAGE,
    apiClient: API_CLIENT
});

const INITIAL_BOOKMARKS = STORAGE.loadBookmarks();

let heroEntrancePlayed = false;
let appMounted = false;
let documentListenersBound = false;

const STATE = {
    theme: STORAGE.loadTheme(),
    scriptMode: STORAGE.loadScriptMode(),
    view: 'landing',
    query: '',
    loading: false,
    loadingMore: false,
    upgrading: false,
    healthChecked: false,
    error: null,
    hostedStatus: null,
    searchNotice: null,
    results: [],
    bookmarks: INITIAL_BOOKMARKS,
    savedOpen: false,
    // Set once the reader has opened a character popover: the "Tap a
    // character" hint under the first headword then never returns.
    charHintSeen: STORAGE.loadCharHintSeen(),
    speakingChengyu: null,
    // Result ids whose example and tags are disclosed on a compact row.
    expandedResults: new Set(),
    // Collapsed result groups opened by the reader: 'loose' (a weak meaning
    // search's guesses).
    revealed: new Set(),
    // Idioms close in meaning to an exact match, looked up once per idiom.
    similar: { key: '', status: 'idle', items: [] },
    search: createEmptySearchState()
};

const FRONTEND_SPEECH_FACTORY = window.ChengyuFrontendSpeech;
if (!FRONTEND_SPEECH_FACTORY) {
    throw new Error('frontend-speech.js must load before app.js');
}
const SPEECH = FRONTEND_SPEECH_FACTORY.createSpeechController({
    state: STATE,
    getResultPublicId,
    render
});

// ---------------------------------------------------------------------------
// Dictionary tooltip system
// ---------------------------------------------------------------------------

const FRONTEND_DICTIONARY_FACTORY = window.ChengyuFrontendDictionary;
if (!FRONTEND_DICTIONARY_FACTORY) {
    throw new Error('frontend-dictionary.js must load before app.js');
}
const DICTIONARY_UI = FRONTEND_DICTIONARY_FACTORY.createDictionaryController({
    escapeHtml,
    escapeRegExp,
    toneMarkPinyinString,
    splitExampleText,
    buildCharacterPins,
    getDisplayHeadword,
    getScriptMode: () => STATE.scriptMode,
    onPopoverShow: dismissCharHint
});
const DICTIONARY = DICTIONARY_UI.dictionary;
const POPOVER_ID = DICTIONARY_UI.popoverId;

function loadDictionaryData() {
    return DICTIONARY_UI.loadDictionaryData();
}

function findAnnotationForChengyu(chengyu, exampleText) {
    return DICTIONARY_UI.findAnnotationForChengyu(chengyu, exampleText);
}

function findDictionaryEntryById(id) {
    return DICTIONARY_UI.findDictionaryEntryById(id);
}

function getDictionaryEntryForChar(char) {
    return DICTIONARY_UI.getDictionaryEntryForChar(char);
}

function renderPopover() {
    return DICTIONARY_UI.renderPopover();
}

function showPopover(targetEl, content) {
    return DICTIONARY_UI.showPopover(targetEl, content);
}

function hidePopover() {
    return DICTIONARY_UI.hidePopover();
}

function buildPopoverContent(entries) {
    return DICTIONARY_UI.buildPopoverContent(entries);
}

function handleDictionaryClick(event) {
    return DICTIONARY_UI.handleDictionaryClick(event);
}

function handleDictionaryKeydown(event) {
    return DICTIONARY_UI.handleDictionaryKeydown(event);
}

function getExampleDisplayText(text, result) {
    return DICTIONARY_UI.getExampleDisplayText(text, result);
}

function renderAnnotatedExample(text, result) {
    return DICTIONARY_UI.renderAnnotatedExample(text, result);
}

function highlightIdiomPlain(text, result) {
    return DICTIONARY_UI.highlightIdiomPlain(text, result);
}

function highlightIdiomInText(text, result) {
    return DICTIONARY_UI.highlightIdiomInText(text, result);
}

// One quiet note in the results heading row says the headword's glyphs
// open the dictionary: "Tap" on touch screens, "Select" where there is a
// pointer that hovers (CSS shows one). It sits right of the heading on wide
// screens and on its own short line under it on phones, never in the
// idiom's reading line. It only appears once the glyphs are live.
function renderCharHint() {
    if (STATE.charHintSeen || !DICTIONARY.loaded) return '';
    return '<p class="char-hint"><span class="char-hint-mark" lang="zh" aria-hidden="true">字</span><span class="char-hint-touch">Tap a character for its meaning</span><span class="char-hint-pointer">Select a character for its meaning</span></p>';
}

// The first popover retires the hint for good. It is removed in place, so
// the open popover and its target stay as they are.
function dismissCharHint() {
    if (STATE.charHintSeen) return;
    STATE.charHintSeen = true;
    STORAGE.persistCharHintSeen();
    document.querySelectorAll?.('.char-hint').forEach(hint => hint.remove());
}

// ---------------------------------------------------------------------------

function persistBookmarks() {
    BOOKMARKS.persistBookmarks(STATE.bookmarks);
}

function formatModeLabel(mode) {
    if (!mode) return 'Search';
    return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatQueryTypeLabel(queryType) {
    return String(queryType || 'unknown')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function formatResultCountLabel() {
    const count = STATE.search.loadedCount;
    if (!count) return 'No idioms';
    const label = `${count}${STATE.search.hasMore ? '+' : ''} ${count === 1 && !STATE.search.hasMore ? 'idiom' : 'idioms'}`;
    return label;
}

// The results header says only what the response supports. Meaning search
// always returns its nearest idioms, however far they are, so it claims no
// match count; keyword, pinyin and hybrid lookups do match their query.
// The query, quoted, in the header's italic; a Chinese query keeps the Song
// face upright instead of a slanted CJK glyph.
function renderQueryQuote(query) {
    const cjk = containsChineseCharacter(query);
    return `<span class="results-query${cjk ? ' is-cjk' : ''}"${cjk ? ' lang="zh"' : ''}>&ldquo;${escapeHtml(query)}&rdquo;</span>`;
}

// "for “query”" after a heading. Phones leave it out (CSS): the query is
// already in the search box above.
function renderQueryEcho(word, query) {
    return `<span class="results-for"> ${word} ${renderQueryQuote(query)}</span>`;
}

function renderResultsHeading() {
    const query = STATE.search.query;
    if (isExactMatchResult(STATE.results[0], 0)) {
        return `<span class="count">Exact match</span>${renderQueryEcho('for', query)}`;
    }
    if (STATE.search.mode === 'semantic') {
        return `<span class="count">Closest idioms</span>${renderQueryEcho('for', query)}`;
    }
    return `<span class="count">${escapeHtml(formatResultCountLabel())}</span>${renderQueryEcho('matching', query)}`;
}

// The API marks a meaning search whose nearest idioms are all distant. The
// signal also fires on some real queries, so the page leads with what to try
// next and keeps its guesses one click away rather than claiming there are no
// results.
function isWeakMatch() {
    return STATE.search.mode === 'semantic' && STATE.search.matchStrength === 'weak';
}

// A weak meaning search leads with what to try next; its distant results
// wait, collapsed, behind one disclosure, and the landing's spark cards fill
// the page below it.
function renderWeakMatchHint() {
    return `
        <div class="weak-hint">
            <h2 class="weak-title">No close match${renderQueryEcho('for', STATE.search.query)}</h2>
            <p class="weak-hint-copy">Try describing the situation or feeling, or type the pinyin.</p>
        </div>
    `;
}

// The one control that reveals a collapsed group of results in place.
function renderRevealToggle({ id, controls, open, label }) {
    return `
        <button type="button" class="reveal-toggle" id="${id}" data-action="toggle-reveal" aria-expanded="${open}" aria-controls="${controls}">
            <span>${label}</span>${renderIcon('chevron')}
        </button>
    `;
}

function getVisibleTags(result) {
    const tags = Array.isArray(result.tags) ? result.tags.slice(0, 4) : [];
    const formality = String(result.formality || '').trim().toLowerCase();

    if (formality && formality !== 'formal' && !tags.includes(formality)) {
        tags.push(formality);
    }

    return tags;
}

function isBookmarked(result) {
    return BOOKMARKS.isBookmarked(STATE.bookmarks, result);
}

function saveBookmark(result) {
    BOOKMARKS.saveBookmark(STATE, result);
}

function removeBookmark(result) {
    BOOKMARKS.removeBookmark(STATE, result);
}

function toggleBookmark(result) {
    BOOKMARKS.toggleBookmark(STATE, result);
    if (Object.keys(STATE.bookmarks).length === 0) {
        STATE.savedOpen = false;
    }
    render();
}

async function pronounceResult(result) {
    return SPEECH.pronounceResult(result);
}

function getDisplayHeadword(result) {
    if (STATE.scriptMode === 'traditional') {
        return result.traditional || result.chengyu;
    }
    return result.simplified || result.chengyu;
}

const UI_SCRIPT_COPY = {
    simplified: {
        siteTitle: '成语搜索',
        chengyu: '成语',
        savedIdioms: '已存成语'
    },
    traditional: {
        siteTitle: '成語搜索',
        chengyu: '成語',
        savedIdioms: '已存成語'
    }
};

function getScriptCopy() {
    return UI_SCRIPT_COPY[STATE.scriptMode] || UI_SCRIPT_COPY.simplified;
}

function renderHeroTitleChars() {
    const pinyin = ['chéng', 'yǔ', 'sōu', 'suǒ'];
    return Array.from(getScriptCopy().siteTitle).map((char, index) => {
        const className = index === 2 ? 'hero-character accent' : 'hero-character';
        return `<span class="${className}"><span class="hero-pinyin">${pinyin[index]}</span><span class="ch">${escapeHtml(char)}</span></span>`;
    }).join('');
}

function getResultPublicId(result) {
    return result?.id || result?.chengyu || '';
}

function getNextScriptMode() {
    return STATE.scriptMode === 'traditional' ? 'simplified' : 'traditional';
}

function buildCopyPayload(result) {
    return getDisplayHeadword(result);
}

async function copyResult(result, button) {
    const payload = buildCopyPayload(result);

    try {
        await navigator.clipboard.writeText(payload);
        flashActionButton(button, 'Copied');
    } catch (error) {
        console.error('Copy failed:', error);
        STATE.error = 'Unable to copy to the clipboard right now.';
        render();
    }
}

function flashActionButton(button, label) {
    if (!button) return;
    // The button is icon-sized, so the confirmation is a check mark; the word
    // goes to screen readers through the status span and the label.
    const original = button.innerHTML;
    const originalLabel = button.getAttribute('aria-label');
    button.classList.add('is-success');
    button.setAttribute('aria-label', label);
    button.innerHTML = `${renderIcon('check')}<span class="visually-hidden" role="status">${escapeHtml(label)}</span>`;
    setTimeout(() => {
        button.classList.remove('is-success');
        button.innerHTML = original;
        if (originalLabel === null) button.removeAttribute('aria-label');
        else button.setAttribute('aria-label', originalLabel);
    }, 1400);
}

async function checkBackendHealth() {
    try {
        const data = await API_CLIENT.fetchHealth();
        STATE.healthChecked = true;
        if (!data.database) {
            STATE.error = 'Backend search index is not ready yet.';
        }
    } catch (error) {
        console.error('Backend health check failed:', error);
        STATE.healthChecked = true;
        STATE.error = 'Backend API not available. Please start the server.';
    }
    render();
}

function bookmarkNeedsRefresh(record) {
    return BOOKMARKS.bookmarkNeedsRefresh(record);
}

async function refreshBookmarksIfNeeded() {
    return BOOKMARKS.refreshBookmarksIfNeeded(STATE);
}

let activeSearch = null;

function cancelActiveSearch() {
    const wasSearching = STATE.loading || STATE.loadingMore || STATE.upgrading;
    activeSearch?.abort();
    activeSearch = null;
    STATE.loading = false;
    STATE.loadingMore = false;
    STATE.upgrading = false;
    if (wasSearching) {
        STATE.hostedStatus = STATE.results.length ? 'complete' : 'cancelled';
        STATE.searchNotice = null;
    }
}

function updateSearchStateFromResponse(data, append = false) {
    STATE.hostedStatus = data.status || null;
    STATE.searchNotice = data.message || null;
    STATE.search = {
        query: data.query,
        mode: data.mode,
        queryType: data.queryType,
        preferredMode: data.preferredMode,
        autoRouted: Boolean(data.autoRouted),
        fallbackFrom: data.fallbackFrom || null,
        embeddingSource: data.embeddingSource || null,
        // Meaning search flags a first page whose nearest idioms are all far
        // from the query. A later page keeps the framing the list opened with.
        matchStrength: append ? STATE.search.matchStrength || null : data.matchStrength || null,
        loadedCount: (data.offset || 0) + (data.results || []).length,
        hasMore: Boolean(data.hasMore),
        nextOffset: data.nextOffset
    };

    if (append) {
        STATE.results = [...STATE.results, ...(data.results || [])];
    } else {
        STATE.results = data.results || [];
    }
}

async function runSearch(query, { append = false } = {}) {
    const trimmed = String(query || '').trim();
    cancelActiveSearch();
    if (!trimmed) {
        STATE.error = 'Please enter a description, Chinese characters, or pinyin.';
        render();
        return;
    }

    STATE.error = null;
    STATE.hostedStatus = null;
    STATE.searchNotice = null;
    const controller = new AbortController();
    activeSearch = controller;
    const offset = append ? STATE.search.nextOffset || 0 : 0;
    const previousSource = STATE.search.embeddingSource;
    const applyResponse = data => {
        if (append && data.embeddingSource !== previousSource) {
            // Never concatenate pages from different rankings.
            STATE.searchNotice = data.message || 'Results have changed. Search again to refresh.';
            return;
        }
        updateSearchStateFromResponse(data, append);
    };
    if (append) {
        STATE.loadingMore = true;
    } else {
        cancelSimilarIdioms();
        STATE.loading = true;
        STATE.view = 'results';
        STATE.results = [];
        STATE.expandedResults = new Set();
        STATE.revealed = new Set();
        STATE.search = createEmptySearchState();
    }
    render();

    try {
        const data = await API_CLIENT.search(trimmed, { offset, signal: controller.signal });
        if (controller.signal.aborted) return;
        STATE.query = trimmed;
        STATE.view = 'results';
        if (data.hostedRequestId && !append) {
            // A first page is shown exactly once. While the hosted ranking is
            // still running, any fallback rows stay off screen; displaying them
            // and then swapping in the hosted ranking erases what people have
            // started reading.
            const fallback = data.results?.length ? data : null;
            STATE.hostedStatus = 'pending';
            render();
            const completed = await API_CLIENT.followHosted(trimmed, data, {
                offset, signal: controller.signal,
                maxWaitMs: fallback ? HOSTED_WAIT_WITH_FALLBACK_MS : HOSTED_WAIT_WITHOUT_FALLBACK_MS
            });
            if (controller.signal.aborted) return;
            if (completed.embeddingSource === 'hosted-qwen') {
                applyResponse(completed);
            } else if (fallback) {
                const { hostedRequestId, ...settled } = fallback;
                applyResponse(settled);
            } else {
                STATE.hostedStatus = 'unavailable';
                STATE.searchNotice = completed.message;
            }
            return;
        }
        if (append && data.status === 'pending') STATE.searchNotice = 'Still searching…';
        else applyResponse(data);
        STATE.loading = false;
        STATE.loadingMore = false;
        STATE.upgrading = Boolean(data.hostedRequestId);
        render();
        if (data.hostedRequestId) {
            // Load-more continuation: appended rows never replace visible ones.
            const completed = await API_CLIENT.followHosted(trimmed, data, { offset, signal: controller.signal });
            if (controller.signal.aborted) return;
            if (completed.embeddingSource === 'hosted-qwen') {
                applyResponse(completed);
            } else {
                STATE.searchNotice = completed.message || null;
            }
        }
    } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Search failed:', error);
        STATE.error = error.message;
        if (!append) {
            STATE.results = [];
            STATE.search = createEmptySearchState();
            STATE.search.query = trimmed;
        }
    } finally {
        if (activeSearch === controller) {
            activeSearch = null;
            STATE.loading = false;
            STATE.loadingMore = false;
            STATE.upgrading = false;
            render();
            if (!append) loadSimilarIdioms();
        }
    }
}

function renderIcon(name) {
    const icons = {
        search: '<path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" d="M11 4a7 7 0 1 0 4.5 12.4l3.8 3.8M11 4a7 7 0 0 1 4.95 11.95"/>',
        sun: '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6" fill="none"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4"/>',
        moon: '<path stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round" d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
        copy: '<rect x="8" y="8" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path stroke="currentColor" stroke-width="1.6" fill="none" d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
        bookmark: '<path stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round" d="M7 4h10a1 1 0 0 1 1 1v16l-6-4-6 4V5a1 1 0 0 1 1-1Z"/>',
        bookmarkFilled: '<path fill="currentColor" d="M7 4h10a1 1 0 0 1 1 1v16l-6-4-6 4V5a1 1 0 0 1 1-1Z"/>',
        volume: '<path stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none" d="M4 10v4h3l5 4V6L7 10H4Z"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
        check: '<path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" d="m5 12.5 4.5 4.5L19 7.5"/>',
        chevron: '<path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" d="m9 6 6 6-6 6"/>',
        download: '<path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" d="M12 4v10M8 10l4 4 4-4M5 19h14"/>',
        github: '<path fill="currentColor" d="M12 .5C5.65.5.5 5.7.5 12.1c0 5.1 3.3 9.42 7.87 10.95.58.11.79-.26.79-.57 0-.28-.01-1.03-.02-2.03-3.2.7-3.87-1.56-3.87-1.56-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.76 1.21 1.76 1.21 1.03 1.79 2.7 1.27 3.36.97.1-.76.4-1.27.73-1.56-2.55-.29-5.23-1.29-5.23-5.76 0-1.27.45-2.31 1.19-3.13-.12-.29-.52-1.46.11-3.03 0 0 .97-.32 3.17 1.2a10.9 10.9 0 0 1 5.77 0c2.19-1.52 3.16-1.2 3.16-1.2.63 1.57.23 2.74.11 3.03.74.82 1.19 1.86 1.19 3.13 0 4.48-2.69 5.46-5.25 5.75.41.36.78 1.08.78 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.21.68.8.57A11.62 11.62 0 0 0 23.5 12.1C23.5 5.7 18.35.5 12 .5Z"/>'
    };

    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

function renderHeader() {
    const bookmarkCount = Object.keys(STATE.bookmarks).length;
    const nextScriptMode = getNextScriptMode();
    const nextScriptLabel = nextScriptMode === 'traditional' ? 'traditional' : 'simplified';
    const scriptCopy = getScriptCopy();

    return `
        <header class="site-header">
            <a class="wordmark" href="#" data-home-link aria-label="Chengyu Search home">
                <div class="seal">成</div>
                <div class="titles">
                    <div class="cn">${escapeHtml(scriptCopy.siteTitle)}</div>
                    <div class="en">Chengyu Search</div>
                </div>
            </a>
            <div class="nav-actions">
                <button class="script-toggle" id="script-toggle" type="button" aria-label="Toggle character script display" aria-pressed="${STATE.scriptMode === 'traditional'}" title="Currently showing ${STATE.scriptMode} characters. Switch to ${nextScriptLabel}.">
                    <span class="script-toggle-option ${STATE.scriptMode === 'simplified' ? 'active' : ''}">简</span>
                    <span class="script-toggle-divider">↔</span>
                    <span class="script-toggle-option ${STATE.scriptMode === 'traditional' ? 'active' : ''}">繁</span>
                </button>
                <button class="saved-pill ${STATE.savedOpen ? 'active' : ''}" id="saved-toggle" title="${STATE.savedOpen ? 'Return to search' : 'Show saved idioms'}" aria-label="${STATE.savedOpen ? 'Return to search' : `Show ${bookmarkCount} saved idioms`}">
                    ${renderIcon('bookmark')}
                    <span class="saved-label">Saved</span>
                    ${bookmarkCount ? `<span class="saved-count">${bookmarkCount}</span>` : ''}
                </button>
                <button class="icon-btn theme-toggle" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">
                    <span class="theme-icon theme-icon-light">${renderIcon('moon')}</span>
                    <span class="theme-icon theme-icon-dark">${renderIcon('sun')}</span>
                </button>
            </div>
        </header>
    `;
}

function renderHero() {
    return `
        <section class="hero" aria-labelledby="landing-title">
            <p class="hero-kicker"><span class="kicker-spark">✦</span> A living dictionary of 7,300+ idioms</p>
            <h1 class="hero-chars" id="landing-title" aria-label="${escapeHtml(getScriptCopy().siteTitle)}">
                ${renderHeroTitleChars()}
            </h1>
            <p class="hero-sub">There’s a four-character phrase for that.</p>
            <p class="hero-copy">Describe the feeling, predicament, or tiny human drama. We’ll help you find the chengyu that says it beautifully.</p>
        </section>
    `;
}

function playHeroEntranceOnce() {
    if (heroEntrancePlayed || STATE.view !== 'landing') return;
    if (!document.querySelectorAll('.hero-character').length) return;

    heroEntrancePlayed = true;
    // index.html starts the entrance on its prerendered hero before first
    // paint. When the first render has to replace that markup (for example a
    // saved script preference), the new characters join the same timeline
    // rather than restarting it. Later renders never replay it.
    window.ChengyuHeroEntrance?.play();
}

function renderSearchSection() {
    return `
        <section class="search-wrap ${STATE.view === 'landing' ? 'search-wrap-landing' : ''}">
            <div class="search-box">
                <div class="search-row">
                    <div class="search-input-wrap">
                        ${renderIcon('search').replace('<svg', '<svg class="magnifier"')}
                        <textarea
                            class="search-input"
                            id="search-input"
                            rows="1"
                            placeholder="Describe a feeling, or type 中文 / pinyin"
                        >${escapeHtml(STATE.query)}</textarea>
                    </div>
                    <button class="search-btn" id="search-btn" ${STATE.loading ? 'disabled' : ''}>
                        ${STATE.loading ? 'Searching…' : 'Search <span class="cn">搜索</span>'}
                    </button>
                </div>
            </div>
            ${STATE.view === 'landing' ? renderSparkCards() : ''}
            ${STATE.error ? `<div class="message-card error-card">${escapeHtml(STATE.error)}</div>` : ''}
        </section>
    `;
}

// The landing's example cards; a no-close-match page offers the same cards.
function renderSparkCards() {
    return `
                <div class="examples-intro">
                    <span class="examples-label">Need a spark?</span>
                </div>
                <div class="examples">
                    ${EXAMPLE_QUERIES.map((example, index) => `
                        <button class="chip" type="button" data-query="${escapeHtml(example.query)}" aria-label="Search for: ${escapeHtml(example.query)} — ${escapeHtml(getDisplayHeadword(example))}">
                            <span class="chip-index">${String(index + 1).padStart(2, '0')}</span>
                            <span class="chip-copy">
                                <span class="chip-label">${escapeHtml(example.query)}</span>
                                <span class="chip-idiom"><span class="cn">${escapeHtml(getDisplayHeadword(example))}</span><span class="chip-pinyin">${escapeHtml(example.pinyin)}</span></span>
                            </span>
                            <span class="chip-arrow" aria-hidden="true">↗</span>
                        </button>
                    `).join('')}
                </div>
            `;
}

function getBookmarkedResults() {
    return BOOKMARKS.getBookmarkedResults(STATE.bookmarks);
}

function exportSavedAsAnki(button) {
    const saved = getBookmarkedResults();
    if (!saved.length) {
        STATE.error = 'Save some idioms first, then export them as Anki cards.';
        render();
        return;
    }

    STATE.error = null;
    const content = buildAnkiExportContent(saved);
    const stamp = new Date().toISOString().slice(0, 10);
    ANKI.downloadTextFile({
        filename: `chengyu-search-anki-${stamp}.tsv`,
        content,
        type: 'text/tab-separated-values;charset=utf-8'
    });

    flashActionButton(button, 'Downloaded');
}

function renderSavedSection() {
    const saved = getBookmarkedResults();
    if (!saved.length || !STATE.savedOpen) {
        return '';
    }

    return `
        <section class="saved-section">
            <div class="saved-head">
                <div class="saved-bar">
                    <button type="button" class="saved-back" id="saved-back-btn">
                        <span aria-hidden="true">←</span> Back to search
                    </button>
                    <p class="saved-bar-meta"><span class="saved-kicker">Your collection</span><span class="saved-meta">${saved.length} saved</span></p>
                </div>
                <div class="saved-toolbar">
                    <h1 class="saved-title">Saved idioms <span>· ${escapeHtml(getScriptCopy().savedIdioms)}</span></h1>
                    <button class="saved-export-btn" id="export-anki-btn" title="Download saved idioms as an Anki-compatible TSV file">
                        ${renderIcon('download')}
                        <span>Export for Anki</span>
                    </button>
                </div>
            </div>
            <div class="saved-grid">
                ${saved.map((result, index) => {
                    const resultId = getResultPublicId(result);
                    const details = hasResultDetails(result) ? renderResultDetails(result, { exampleLabel: false }) : '';
                    const detailsKey = `saved:${resultId}`;
                    const expanded = STATE.expandedResults.has(detailsKey);
                    const detailsId = `saved-details-${index + 1}`;
                    // The idiom gets the card's full width; its actions sit
                    // in a footer row pinned to the card's foot.
                    return `
                    <article class="saved-card${getHeadwordLengthClass(getDisplayHeadword(result))}${expanded ? ' is-expanded' : ''}" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}">
                        <button class="saved-card-main" data-saved-query="${escapeHtml(result.chengyu)}" title="Search this idiom">
                            <div class="saved-card-chars" lang="${getScriptLang()}"><span class="visually-hidden">${escapeHtml(getDisplayHeadword(result))} (${escapeHtml(toneMarkPinyinString(result.pinyin))})</span><span class="saved-ruby" aria-hidden="true">${renderStaticHeadword(result)}</span></div>
                            <div class="saved-card-meaning">${escapeHtml(splitMeaningNote(result.meaning).text)}</div>
                            ${renderLiteralLine(result, 'div', 'saved-card-literal')}
                        </button>
                        <div class="saved-card-preview">
                            ${details ? renderPreviewToggle({ result, key: detailsKey, controls: detailsId, expanded }) : ''}
                        </div>
                        <div class="saved-details-slot">${details ? `<div class="result-body saved-details" id="${detailsId}"${expanded ? '' : ' hidden'}>${details}</div>` : ''}</div>
                        <div class="saved-card-foot">${renderResultActions(result)}</div>
                    </article>
                `;
                }).join('')}
            </div>
        </section>
    `;
}

// The same per-glyph ruby as result headwords, without dictionary targets:
// a saved card is itself one button, so it holds no nested controls.
function renderStaticHeadword(result) {
    const pins = buildCharacterPins(getDisplayHeadword(result), result.pinyin);
    const breakAt = DICTIONARY_UI.headwordBreakIndex(pins);
    const styles = DICTIONARY_UI.pinStyles(pins);
    return pins.map((item, index) => (item.punctuation
        ? `<span class="ch punct">${escapeHtml(item.char)}</span>`
        : `<span class="ch">${DICTIONARY_UI.renderPin(item.pin, styles[index])}${escapeHtml(item.char)}</span>`)
        + (index === breakAt ? DICTIONARY_UI.headwordBreak : '')).join('');
}

// Every glyph in an idiom is one size, and its pinyin never shrinks. A long
// idiom steps its whole headword down a size instead: hw-6 for five or six
// glyphs on a line, hw-8 for seven or eight. One with a full-width comma, or
// of more than eight glyphs, always breaks at its .hw-break (hw-split); it
// is sized by its longer line.
function getHeadwordLengthClass(headword) {
    const pins = buildCharacterPins(headword || '', '');
    const breakAt = DICTIONARY_UI.headwordBreakIndex(pins);
    const glyphs = list => list.filter(item => !item.punctuation).length;
    const split = breakAt >= 0 && (pins[breakAt].punctuation || glyphs(pins) > 8);
    const line = split ? Math.max(glyphs(pins.slice(0, breakAt + 1)), glyphs(pins.slice(breakAt + 1))) : glyphs(pins);
    const size = line <= 4 ? '' : line <= 6 ? ' hw-6' : ' hw-8';
    return `${size}${split ? ' hw-split' : ''}`;
}

function getScriptLang() {
    return STATE.scriptMode === 'traditional' ? 'zh-Hant' : 'zh-Hans';
}

function renderCharacterCluster(result) {
    return DICTIONARY_UI.renderCharacterCluster(result);
}

function renderSegmentedHeadword(pins, headwordTokens) {
    return DICTIONARY_UI.renderSegmentedHeadword(pins, headwordTokens);
}

function renderTagChips(result) {
    const tags = getVisibleTags(result);
    if (!tags.length) return '';

    return tags.map(tag => {
        const lowered = String(tag || '').toLowerCase();
        const specialClass = lowered === 'neutral' ? ' neutral' : lowered === 'colloquial' ? ' colloquial' : '';
        return `<span class="tag${specialClass}">${escapeHtml(tag)}</span>`;
    }).join('');
}

// The lead entry (the first result, or an exact match) names its save
// action in text beside the icon: "Save", or "Saved" with the filled accent
// bookmark. Listen and copy stay icon-only everywhere, as do rows.
function renderResultActions(result, { labelSave = false } = {}) {
    const bookmarked = isBookmarked(result);
    const resultId = escapeHtml(getResultPublicId(result));
    const chengyu = escapeHtml(result.chengyu);
    const isSpeaking = STATE.speakingChengyu === getResultPublicId(result);
    const pronounceLabel = isSpeaking ? 'Stop pronunciation' : 'Pronounce idiom';
    const saveLabel = bookmarked ? 'Remove from saved' : 'Save idiom';
    // One cluster everywhere (results and saved cards): same order, same
    // buttons, each with a tooltip and an accessible name. Saved shows as a
    // filled accent bookmark.
    // The other state's word sits invisibly in the same cell, so the
    // button keeps one width when it is pressed.
    const saveText = labelSave
        ? `<span class="save-text" aria-hidden="true"><span>${bookmarked ? 'Saved' : 'Save'}</span><span class="save-text-sizer">${bookmarked ? 'Save' : 'Saved'}</span></span>`
        : '';
    return `
        <div class="card-actions">
            <button type="button" class="icon-btn card-action ${isSpeaking ? 'active' : ''}" data-action="pronounce" data-result-id="${resultId}" data-chengyu="${chengyu}" title="${pronounceLabel}" aria-label="${pronounceLabel}">
                ${renderIcon('volume')}
            </button>
            <button type="button" class="icon-btn card-action save-action ${bookmarked ? 'active' : ''}${labelSave ? ' has-label' : ''}" data-action="bookmark" data-result-id="${resultId}" data-chengyu="${chengyu}" title="${saveLabel}" aria-label="${saveLabel}" aria-pressed="${bookmarked}">
                ${renderIcon(bookmarked ? 'bookmarkFilled' : 'bookmark')}${saveText}
            </button>
            <button type="button" class="icon-btn card-action" data-action="copy" data-result-id="${resultId}" data-chengyu="${chengyu}" title="Copy idiom" aria-label="Copy idiom">
                ${renderIcon('copy')}
            </button>
        </div>
    `;
}

// The example under its eyebrow. A compact row's disclosure already reads
// "例句 · Example" once open, so its panel leaves the label out.
function renderExampleBlock(result, { label = true } = {}) {
    const { zh, en } = splitExampleText(result.example);
    if (!zh) return '';

    return `
        <div class="field example-block">
            ${label ? '<span class="field-label">例句 · Example</span>' : ''}
            <div class="example-quote">
                <div class="example-zh">${highlightIdiomInText(zh, result)}</div>
                ${en ? `<div class="example-en">${escapeHtml(en)}</div>` : ''}
            </div>
        </div>
    `;
}

// An exact headword or pinyin lookup returns the idiom itself first with a
// full relevance score; the rest of the page is then related idioms, not
// competing matches.
function isExactMatchResult(result, index) {
    return index === 0
        && Number(result?.relevance_score) === 100
        && (STATE.search.queryType === 'pinyin' || STATE.search.queryType === 'chinese_exact');
}

// A gloss with several ';'-separated senses shows its first two in full; the
// rest wait behind the details disclosure instead of an ellipsis.
// The literal gloss, with any dictionary note lifted out of the meaning
// ("from Analects") set after it as a quiet aside.
function renderLiteralLine(result, tag = 'p', className = 'literal-line') {
    const { note } = splitMeaningNote(result.meaning);
    const literal = result.literal ? `<span class="lit-label">lit.</span> &ldquo;${escapeHtml(result.literal)}&rdquo;` : '';
    const aside = note ? `<span class="meaning-note">${escapeHtml(note)}</span>` : '';
    if (!literal && !aside) return '';
    return `<${tag} class="${className}">${literal}${literal && aside ? '<span class="meaning-note-sep" aria-hidden="true"> · </span>' : ''}${aside}</${tag}>`;
}

// Other forms of the same idiom, which the server folded into this result,
// in one block, one labelled group per relation: 也作 · Also written (one idiom
// written two ways), 略作 · Short form and 全句 · Full saying (a short form and
// the saying it opens or comes from; only each one's usual spelling, the rest
// are a click away), and on the first result its other script. Each form
// searches itself; the family's usual form says so. Rows show three forms on
// one line and link the rest through the idiom's own page, where an exact
// match lists every form with its pinyin. (略作, not 简作: 简 already means
// Simplified in the script toggle.)
const VARIANT_ROW_LIMIT = 3;
const VARIANT_GROUPS = [
    { key: 'same', zh: '也作', en: 'Also written' },
    { key: 'short', zh: '略作', en: 'Short form' },
    { key: 'full', zh: '全句', en: 'Full saying' }
];

function getVariantGroups(result) {
    const variants = Array.isArray(result?.variants) ? result.variants.filter(v => v && (v.simplified || v.traditional)) : [];
    const ownLength = Array.from(String(result?.simplified || result?.chengyu || '')).length;
    const groups = VARIANT_GROUPS.map(group => ({ ...group, forms: [] }));
    const byKey = Object.fromEntries(groups.map(group => [group.key, group]));
    for (const variant of variants) {
        if (variant.relation !== 'full_form') {
            byKey.same.forms.push(variant);
            continue;
        }
        // A short form or full saying is listed in its usual spelling only.
        if (variant.common === false && !variant.preferred) continue;
        const length = Array.from(String(variant.simplified || variant.traditional)).length;
        byKey[length > ownLength ? 'full' : 'short'].forms.push(variant);
    }
    return groups.filter(group => group.forms.length);
}

function renderFormsLabel(zh, en) {
    return `<span class="variant-label"><span class="variant-label-zh" lang="zh-Hans">${zh}</span> ${en}</span>`;
}

// Generated pinyin keeps a space before punctuation ("qí fàng , bǎi").
function formatFormPinyin(pinyin) {
    return pinyin ? toneMarkPinyinString(pinyin).replace(/\s+([,，。;；:：!！?？])/g, '$1') : '';
}

// One form is one unit: its characters, the usual-form mark and, where shown,
// its pinyin; units wrap as wholes, so no separator can strand at a line edge.
function renderVariantForm(form, { lang, withPinyin }) {
    const text = getDisplayHeadword({ ...form, chengyu: form.simplified });
    const pinyin = formatFormPinyin(form.pinyin);
    const common = form.preferred ? '<span class="variant-common">more common</span>' : '';
    const label = `Search for ${text}${pinyin ? ` (${pinyin})` : ''}${form.preferred ? ', the more common form' : ''}`;
    const title = !withPinyin && pinyin ? ` title="${escapeHtml(pinyin)}"` : '';
    return `<span class="variant-item"><button type="button" class="variant-form" lang="${lang}" data-similar-query="${escapeHtml(form.simplified || form.traditional)}" aria-label="${escapeHtml(label)}"${title}>${escapeHtml(text)}</button>${common}${withPinyin && pinyin ? `<span class="variant-pin">${escapeHtml(pinyin)}</span>` : ''}</span>`;
}

function renderVariantLine(result, { limit = VARIANT_ROW_LIMIT, withScript = false, withPinyin = false } = {}) {
    const groups = getVariantGroups(result);
    const lang = getScriptLang();
    let shown = 0;
    let hidden = 0;
    const lines = groups.map(group => {
        const forms = group.forms.filter(() => (shown < limit ? (shown += 1, true) : (hidden += 1, false)));
        if (!forms.length) return '';
        const items = forms.map(form => renderVariantForm(form, { lang, withPinyin })).join(' ');
        return `<span class="variant-group">${renderFormsLabel(group.zh, group.en)} <span class="variant-forms">${items}</span></span>`;
    }).filter(Boolean);
    if (hidden) {
        const own = result.simplified || result.chengyu;
        lines.push(`<span class="variant-group"><button type="button" class="variant-more" data-similar-query="${escapeHtml(own)}" aria-label="See all ${shown + hidden} forms of ${escapeHtml(getDisplayHeadword(result))}">+${hidden} more ${hidden === 1 ? 'form' : 'forms'}</button></span>`);
    }
    if (withScript) {
        const showingTraditional = STATE.scriptMode === 'traditional';
        const shownForm = getDisplayHeadword(result);
        const other = showingTraditional ? (result.simplified || result.chengyu) : result.traditional;
        if (other && other !== shownForm) {
            const label = showingTraditional ? renderFormsLabel('简体', 'Simplified') : renderFormsLabel('繁體', 'Traditional');
            lines.push(`<span class="variant-group">${label} <span class="variant-forms"><span class="variant-script" lang="${showingTraditional ? 'zh-Hans' : 'zh-Hant'}">${escapeHtml(other)}</span></span></span>`);
        }
    }
    if (!lines.length) return '';
    return `<p class="variant-line">${lines.join('')}</p>`;
}

function renderMeaning(meaning, canDisclose) {
    const { text } = splitMeaningNote(meaning);
    const senses = text.split(/;\s*/).filter(Boolean);
    if (!canDisclose || senses.length <= 2) return escapeHtml(text);
    return `${escapeHtml(senses.slice(0, 2).join('; '))}<span class="meaning-more">; ${escapeHtml(senses.slice(2).join('; '))}</span>`;
}

function hasResultDetails(result) {
    return Boolean(splitExampleText(result.example).zh) || getVisibleTags(result).length > 0;
}

// The idiom's Chinese gloss (释义). One rule at every width: it teaches the
// idiom on an exact-match page and never appears on a search result.
function renderGlossZh(result) {
    const text = String(result.meaning_zh || '').trim();
    if (!text) return '';
    return `
        <div class="field gloss-zh-block">
            <span class="field-label">释义 · Chinese gloss</span>
            <p class="gloss-zh" lang="zh-Hans">${escapeHtml(text)}</p>
        </div>
    `;
}

// A result's example and tags: open on the first result (whose tags follow
// its other script instead), behind the example preview on rows and saved
// cards.
function renderResultDetails(result, { exampleLabel = true, tags = true } = {}) {
    const chips = tags ? renderTagChips(result) : '';
    return `${renderExampleBlock(result, { label: exampleLabel })}${chips ? `<div class="tags-row">${chips}</div>` : ''}`;
}

// The first result's tags, under its example's translation (its other
// script sits with its other forms). On phones they wait behind one inline
// "Tags" disclosure right after the example, whose translation shows in full.
function renderHeroExtra(result, id) {
    const tags = renderTagChips(result);
    if (!tags) return '';
    return `<div class="hero-extra" id="${id}"><div class="tags-row">${tags}</div></div>`;
}

// "Tags ›": a small text disclosure (phones only; CSS shows it) for the
// tags that follow it.
function renderHeroMore({ result, controls, expanded }) {
    return `<button type="button" class="hero-more" data-action="toggle-details" data-result-id="${escapeHtml(getResultPublicId(result))}" aria-expanded="${expanded}" aria-controls="${controls}" data-label-closed="Tags" data-label-open="Hide tags"><span class="hero-more-label">${expanded ? 'Hide tags' : 'Tags'}</span>${renderIcon('chevron')}</button>`;
}

// How many characters of a one-line preview show before its ellipsis: on a
// wide result row, and on a phone row or a saved card.
const PREVIEW_VISIBLE_CHARS = { wide: 34, narrow: 16 };

// The Chinese example for a one-line preview: from its start, cut only at
// the end (CSS ellipsis). When the idiom would end past the visible line, the
// preview starts at the clause holding it, after the nearest preceding
// clause mark, with a leading ellipsis; never mid-clause.
function getExamplePreviewText(zh, result, visibleChars = PREVIEW_VISIBLE_CHARS.narrow) {
    const at = zh.indexOf(result.chengyu);
    if (at < 0 || at + result.chengyu.length <= visibleChars) return zh;
    const before = zh.slice(0, at);
    const boundary = Math.max(...['，', '。', '；', '：', '！', '？', ',', ';', ':'].map(mark => before.lastIndexOf(mark)));
    return boundary >= 0 ? `…${zh.slice(boundary + 1)}` : zh;
}

// A compact row's example disclosure is a one-line preview of the Chinese
// example itself; opening it shows the whole example, its translation and
// the tags beneath, and the line becomes the "例句 · Example" label. A result
// row whose idiom falls late in its example carries both cuts of the line;
// CSS shows the one that fits the row's width. A result row also carries the
// English translation as a second line, which CSS shows on wide screens
// only, cut to one line; open, the panel holds it in full.
function renderPreviewToggle({ result, key, controls, expanded, wide = false }) {
    const { zh, en } = splitExampleText(result.example);
    const hasTags = getVisibleTags(result).length > 0;
    const openLabel = zh ? '例句 · Example' : 'Tags';
    const lang = getScriptLang();
    const narrowText = zh ? getExamplePreviewText(zh, result) : '';
    const wideText = zh && wide ? getExamplePreviewText(zh, result, PREVIEW_VISIBLE_CHARS.wide) : narrowText;
    const preview = !zh
        ? '<span class="preview-zh preview-tags">Tags</span>'
        : wideText === narrowText
            ? `<span class="preview-zh" lang="${lang}">${highlightIdiomPlain(narrowText, result)}</span>`
            : `<span class="preview-zh preview-wide" lang="${lang}">${highlightIdiomPlain(wideText, result)}</span><span class="preview-zh preview-narrow" lang="${lang}">${highlightIdiomPlain(narrowText, result)}</span>`;
    return `
                        <button type="button" class="example-preview" data-action="toggle-details" data-result-id="${escapeHtml(key)}" aria-expanded="${expanded}" aria-controls="${controls}">
                            ${zh ? `<span class="visually-hidden preview-prefix">${hasTags ? 'Example and tags:' : 'Example:'} </span>` : ''}${preview}<span class="preview-open-label">${openLabel}</span>${renderIcon('chevron')}${zh && en && wide ? `<span class="preview-en"> ${escapeHtml(en)}</span>` : ''}
                        </button>
                    `;
}

function renderResultCard(result, index, { exact = false, solo = false } = {}) {
    const resultId = getResultPublicId(result);
    // A weak meaning search features nothing: every result is a compact row.
    const isPrimary = index === 0 && !isWeakMatch();
    const expanded = STATE.expandedResults.has(resultId);
    const detailsId = `result-details-${index + 1}`;
    const headword = renderCharacterCluster(result);
    // The first result always shows its example, then its other script and
    // tags (on phones behind "Tags", between the two); on an exact match
    // its 释义 follows its lit. gloss. Compact rows preview their example on
    // one line; the preview discloses the rest.
    const extraId = `result-extra-${index + 1}`;
    const extra = isPrimary ? renderHeroExtra(result, extraId) : '';
    const more = extra ? renderHeroMore({ result, controls: extraId, expanded }) : '';
    const details = isPrimary
        ? renderResultDetails(result, { tags: false }) + more + extra
        : (hasResultDetails(result) ? renderResultDetails(result, { exampleLabel: false }) : '');
    const preview = !isPrimary && details ? renderPreviewToggle({ result, key: resultId, controls: detailsId, expanded, wide: true }) : '';
    // A lone exact match is not ranked against anything: no numeral.
    const rank = solo ? '' : `<div class="rank-badge">${String(index + 1).padStart(2, '0')}</div>`;

    return `
        <article class="result-card ${isPrimary ? 'rank-1' : 'result-row'}${getHeadwordLengthClass(getDisplayHeadword(result))}${expanded ? ' is-expanded' : ''}" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}">
            <div class="hero-row">
                ${rank}
                <div class="headword-block">
                    <h3 class="result-chars">${headword}</h3>
                </div>
                <div class="gloss-block">
                    <p class="result-meaning">${renderMeaning(result.meaning, Boolean(details))}</p>
                    ${renderLiteralLine(result)}
                    ${renderVariantLine(result, { limit: exact ? Infinity : VARIANT_ROW_LIMIT, withScript: isPrimary, withPinyin: isPrimary })}
                    ${isPrimary && exact ? renderGlossZh(result) : ''}
                    ${preview}
                </div>
                ${renderResultActions(result, { labelSave: isPrimary })}
            </div>
            ${isPrimary ? (details.trim() ? `<div class="result-body hero-body" id="${detailsId}">${details}</div>` : '') : (details ? `
                <div class="result-body result-details" id="${detailsId}"${expanded ? '' : ' hidden'}>${details}</div>
            ` : '')}
        </article>
    `;
}

// A dictionary sense, trimmed for a one-line gloss: no measure words,
// cross-references or pinyin brackets.
function cleanCharacterSense(sense) {
    return String(sense || '')
        .replace(/\(?CL:[^)]*\)?/g, '')
        .replace(/\((?:variant of|old variant of|see|also written|same as)[^)]*\)/gi, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\(bound form\)\s*/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s;,]+|[\s;,]+$/g, '');
}

// One cell per hanzi: the glyph, its reading in this idiom and a short
// gloss from the dictionary the popover uses. A cell opens that popover.
function renderCharacterStrip(result) {
    if (!DICTIONARY.loaded) return '';
    const cells = buildCharacterPins(getDisplayHeadword(result), result.pinyin)
        .filter(item => !item.punctuation)
        .map(item => {
            const entry = getDictionaryEntryForChar(item.char);
            const gloss = entry ? (entry.definitions || []).map(cleanCharacterSense).filter(Boolean).slice(0, 2).join('; ') : '';
            const body = `<span class="char-cell-glyph" lang="${getScriptLang()}">${escapeHtml(item.char)}</span><span class="char-cell-pin">${escapeHtml(item.pin)}</span>${gloss ? `<span class="char-cell-gloss">${escapeHtml(gloss)}</span>` : ''}`;
            return entry
                ? `<li><button type="button" class="char-cell" data-dict-char="${escapeHtml(item.char)}">${body}</button></li>`
                : `<li><span class="char-cell">${body}</span></li>`;
        });
    if (!cells.length) return '';
    const columns = cells.length <= 4 ? cells.length : Math.ceil(cells.length / 2);
    return `
        <div class="exact-section">
            <h3 class="exact-label">逐字 · Character by character</h3>
            <ol class="char-strip" style="--cells: ${columns}">${cells.join('')}</ol>
        </div>
    `;
}

// Idioms near the exact match in meaning, fetched once (lazily) per idiom.
function renderSimilarIdioms(result) {
    const similar = STATE.similar;
    if (similar.key !== getResultPublicId(result) || similar.status !== 'done' || !similar.items.length) return '';
    return `
        <div class="exact-section">
            <h3 class="exact-label">近义 · Similar in meaning</h3>
            <ul class="similar-chips">
                ${similar.items.map(item => `
                    <li><button type="button" class="similar-chip" data-similar-query="${escapeHtml(item.chengyu)}" aria-label="Search for ${escapeHtml(getDisplayHeadword(item))} (${escapeHtml(toneMarkPinyinString(item.pinyin))})${item.meaning ? `: ${escapeHtml(splitMeaningNote(item.meaning).text)}` : ''}">
                        <span class="similar-head">
                            <span class="similar-cn" lang="${getScriptLang()}">${escapeHtml(getDisplayHeadword(item))}</span>
                            <span class="similar-pin">${escapeHtml(toneMarkPinyinString(item.pinyin))}</span>
                        </span>
                        ${item.meaning ? `<span class="similar-gloss">${escapeHtml(splitMeaningNote(item.meaning).text)}</span>` : ''}
                    </button></li>
                `).join('')}
            </ul>
        </div>
    `;
}

function renderExactExtras(result) {
    const sections = `${renderCharacterStrip(result)}${renderSimilarIdioms(result)}`;
    return sections.trim() ? `<div class="exact-extras">${sections}</div>` : '';
}

let similarController = null;

// After an exact match, one search with the idiom's English meaning finds
// its neighbours. It runs once per idiom, never on re-render; if it fails or
// finds nothing, the section simply does not appear.
async function loadSimilarIdioms() {
    const result = STATE.results[0];
    if (STATE.view !== 'results' || !isExactMatchResult(result, 0)) return;
    const key = getResultPublicId(result);
    if (STATE.similar.key === key) return;
    const query = splitMeaningNote(result.meaning).text;
    if (!query) {
        STATE.similar = { key, status: 'failed', items: [] };
        return;
    }
    similarController?.abort();
    const controller = new AbortController();
    similarController = controller;
    STATE.similar = { key, status: 'loading', items: [] };
    try {
        const data = await API_CLIENT.search(query, { offset: 0, signal: controller.signal });
        if (controller.signal.aborted || STATE.similar.key !== key) return;
        const seen = new Set([result.chengyu, ...(result.variants || []).map(v => v.simplified)]);
        const items = (data.results || []).filter(item => {
            if (!item?.chengyu || getResultPublicId(item) === key || seen.has(item.chengyu)) return false;
            seen.add(item.chengyu);
            return true;
        }).slice(0, 5);
        STATE.similar = { key, status: 'done', items };
    } catch (error) {
        if (controller.signal.aborted || STATE.similar.key !== key) return;
        STATE.similar = { key, status: 'failed', items: [] };
    } finally {
        if (similarController === controller) similarController = null;
    }
    render();
}

function cancelSimilarIdioms() {
    if (!similarController) return;
    similarController.abort();
    similarController = null;
    // An unfinished lookup may run again if the idiom comes back.
    if (STATE.similar.status === 'loading') STATE.similar = { key: '', status: 'idle', items: [] };
}

function toggleResultDetails(button) {
    const resultId = button.dataset.resultId;
    const card = button.closest('.result-card, .saved-card');
    const panel = document.getElementById(String(button.getAttribute('aria-controls') || '').split(' ')[0]);
    if (!resultId || !card || !panel) return;
    const expanded = !STATE.expandedResults.has(resultId);
    if (expanded) STATE.expandedResults.add(resultId);
    else STATE.expandedResults.delete(resultId);
    // Update in place so focus stays on the toggle; the next full render
    // produces the same markup from STATE. The first result's extras are
    // collapsed by CSS (phones only), never by the hidden attribute.
    button.setAttribute('aria-expanded', String(expanded));
    const label = button.querySelector?.('.hero-more-label');
    if (label) label.textContent = expanded ? button.dataset.labelOpen : button.dataset.labelClosed;
    if (!card.classList.contains('rank-1')) panel.hidden = !expanded;
    card.classList.toggle('is-expanded', expanded);
}

function renderResultsSection() {
    if (STATE.hostedStatus === 'pending' || STATE.hostedStatus === 'unavailable' || STATE.hostedStatus === 'cancelled'
        || (!STATE.results.length && STATE.searchNotice)) {
        const message = STATE.hostedStatus === 'pending' ? 'Still searching…'
            : STATE.hostedStatus === 'cancelled' ? 'Search changed. Submit your new query to search.' : STATE.searchNotice;
        return `<section class="results-wrap layout-hero"><div class="message-card" role="status">${escapeHtml(message)}</div></section>`;
    }
    if (STATE.loading && STATE.results.length === 0) {
        return `
            <section class="results-wrap layout-hero">
                <div class="message-card loading-card">Searching the idiom archive…</div>
            </section>
        `;
    }

    if (!STATE.results.length) {
        return `
            <section class="results-wrap layout-hero">
                <div class="message-card no-results-card">
                    <p class="message-title">No matching idioms found.</p>
                    <p>Try describing the situation differently, or switch between English, Chinese characters, and pinyin phrasing.</p>
                </div>
            </section>
        `;
    }

    const weak = isWeakMatch();
    const exact = !weak && isExactMatchResult(STATE.results[0], 0);
    const looseOpen = STATE.revealed.has('loose');
    let list;
    if (weak) {
        const count = STATE.results.length;
        const cards = STATE.results.map((result, index) => renderResultCard(result, index));
        list = `
            <div class="results-reveal">${renderRevealToggle({ id: 'loose-toggle', controls: 'loose-results', open: looseOpen,
                label: looseOpen ? 'Hide loose guesses' : `Show ${count} loose ${count === 1 ? 'guess' : 'guesses'}` })}</div>
            <div class="results-grid is-weak" id="loose-results"${looseOpen ? '' : ' hidden'}>${cards.join('')}</div>
        `;
    } else if (exact) {
        // An exact lookup teaches the idiom instead of listing unrelated
        // ones: its card (and any other reading of the same query), then
        // its characters one by one and idioms close to it in meaning.
        const shown = STATE.results.filter((result, index) => index === 0 || Number(result.relevance_score) === 100);
        const cards = STATE.results
            .map((result, index) => (index === 0 || Number(result.relevance_score) === 100
                ? renderResultCard(result, index, { exact: true, solo: shown.length === 1 }) : ''))
            .join('');
        list = `<div class="results-grid is-exact">${cards}</div>${renderExactExtras(STATE.results[0])}`;
    } else {
        const cards = STATE.results.map((result, index) => renderResultCard(result, index));
        list = `<div class="results-grid">${cards.join('')}</div>`;
    }
    // Paging continues a list only once its collapsed rows are showing; an
    // exact match has no list to page.
    const canLoadMore = STATE.search.hasMore && (weak ? looseOpen : !exact);

    return `
        <section class="results-wrap layout-hero${weak ? ' is-weak-state' : ''}">
            ${STATE.searchNotice ? `<div class="message-card" role="status">${escapeHtml(STATE.searchNotice)}</div>` : ''}
            ${weak ? renderWeakMatchHint() : `
                <div class="results-head" id="results-head">
                    <h2 class="results-title" title="${escapeHtml(STATE.search.query)}">
                        ${renderResultsHeading()}
                    </h2>
                    ${renderCharHint()}
                </div>
            `}
            ${list}
            ${weak && !looseOpen ? `<div class="results-sparks">${renderSparkCards()}</div>` : ''}
            ${canLoadMore ? `
                <div class="results-actions">
                    <button type="button" id="load-more-btn" class="load-more-btn" ${STATE.loadingMore || STATE.upgrading ? 'disabled' : ''}>
                        <span>${STATE.loadingMore ? 'Loading…' : weak ? 'Show more loose guesses' : STATE.search.mode === 'semantic' ? 'Show more close idioms' : 'Load more results'}</span>${renderIcon('chevron')}
                    </button>
                </div>
            ` : ''}
        </section>
    `;
}

function toggleReveal(button) {
    const group = 'loose';
    if (STATE.revealed.has(group)) STATE.revealed.delete(group);
    else STATE.revealed.add(group);
    render();
    document.getElementById(button.id)?.focus({ preventScroll: true });
}

// Once the search box has scrolled away, a slim bar keeps the query in reach;
// tapping it returns to the box with the query ready to refine.
const STICKY_SEARCH_OFFSET = 200;
// Set while the page scrolls back up to the search box after a tap on the
// bar, so the bar does not flash back in on the way.
let stickySearchReturning = false;

function renderStickySearch() {
    const query = STATE.search.query || STATE.query;
    return `
        <div class="sticky-search">
            <button type="button" class="sticky-search-btn" id="sticky-search-btn" aria-label="Refine search: ${escapeHtml(query)}">
                <span class="sticky-seal" aria-hidden="true">成</span>
                <span class="sticky-search-query">${escapeHtml(query)}</span>
                <span class="sticky-search-chip" aria-hidden="true">Search <span class="cn">搜索</span></span>
            </button>
        </div>
    `;
}

function updateStickySearch() {
    const body = document.body;
    if (!body?.classList) return;
    const scrolled = (window.scrollY || 0) > STICKY_SEARCH_OFFSET;
    if (!scrolled) stickySearchReturning = false;
    const show = Boolean(document.getElementById('sticky-search-btn')) && scrolled && !stickySearchReturning;
    body.classList.toggle('show-sticky-search', show);
}

function focusSearchInput() {
    const input = document.getElementById('search-input');
    if (!input) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
    stickySearchReturning = true;
    window.scrollTo?.({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    updateStickySearch();
}

function renderFooter() {
    return `
        <footer class="foot">
            <span class="footer-title">Chengyu Search</span>
            <a class="footer-link" href="${PUBLIC_GITHUB_URL}" target="_blank" rel="noreferrer noopener">
                ${renderIcon('github')}
                <span>Source code</span>
            </a>
        </footer>
    `;
}

function render() {
    document.body.dataset.theme = STATE.theme;
    // Text typed into the prerendered page before scripts loaded survives a
    // first render that has to replace it.
    if (!appMounted) syncQueryFromInput();

    const app = document.getElementById('app');
    const primaryContent = STATE.savedOpen
        ? renderSavedSection()
        : `
            ${STATE.view === 'landing' ? renderHero() : ''}
            ${renderSearchSection()}
            ${STATE.view === 'results' ? renderResultsSection() : ''}
            ${STATE.view === 'results' ? renderStickySearch() : ''}
        `;

    const html = `
        ${renderHeader()}
        ${primaryContent}
        ${renderFooter()}
        ${renderPopover()}
    `;

    // Compare parsed markup with parsed markup: the browser serializes entities
    // and attributes differently from the template strings, so a raw string
    // comparison would rebuild an unchanged page on every render.
    const probe = document.createElement('template');
    probe.innerHTML = html;
    const changed = probe.innerHTML !== app.innerHTML;
    if (!changed && !appMounted) {
        // The prerendered landing page from index.html already matches, and
        // its entrance is already running: keep the DOM and attach handlers.
        appMounted = true;
        heroEntrancePlayed = true;
        bind();
        return;
    }
    if (changed) {
        appMounted = true;
        const input = document.getElementById('search-input');
        const selection = input && document.activeElement === input ? {
            start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
            scrollTop: input.scrollTop, scrollLeft: input.scrollLeft
        } : null;
        app.innerHTML = html;
        bind();
        playHeroEntranceOnce();
        const replacement = selection && document.getElementById('search-input');
        if (replacement) {
            replacement.focus({ preventScroll: true });
            replacement.setSelectionRange(selection.start, selection.end, selection.direction);
            replacement.scrollTop = selection.scrollTop;
            replacement.scrollLeft = selection.scrollLeft;
        }
        updateStickySearch();
    }
}

function bind() {
    document.querySelector('[data-home-link]')?.addEventListener('click', event => {
        event.preventDefault();
        STATE.view = 'landing';
        STATE.savedOpen = false;
        STATE.error = null;
        render();
    });

    document.getElementById('script-toggle')?.addEventListener('click', () => {
        syncQueryFromInput();
        STATE.scriptMode = getNextScriptMode();
        STORAGE.persistScriptMode(STATE.scriptMode);
        render();
    });

    document.getElementById('saved-toggle')?.addEventListener('click', () => {
        if (!Object.keys(STATE.bookmarks).length) {
            return;
        }
        syncQueryFromInput();
        STATE.savedOpen = !STATE.savedOpen;
        render();
    });

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        syncQueryFromInput();
        STATE.theme = STATE.theme === 'dark' ? 'light' : 'dark';
        STORAGE.persistTheme(STATE.theme);
        render();
    });

    const searchInput = document.getElementById('search-input');
    fitSearchInput(searchInput);
    searchInput?.addEventListener('input', event => {
        fitSearchInput(event.target);
        const changed = STATE.query !== event.target.value;
        STATE.query = event.target.value;
        if (changed && activeSearch) {
            cancelActiveSearch();
            render();
        }
    });
    searchInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            runSearch(searchInput.value);
        }
    });

    document.getElementById('search-btn')?.addEventListener('click', () => {
        const input = document.getElementById('search-input');
        runSearch(input ? input.value : STATE.query);
    });

    document.querySelectorAll('.chip[data-query], .spark-chip[data-query]').forEach(chip => {
        chip.addEventListener('click', () => {
            const query = chip.dataset.query || '';
            STATE.query = query;
            runSearch(query);
        });
    });

    document.querySelectorAll('[data-similar-query]').forEach(button => {
        button.addEventListener('click', () => {
            const query = button.dataset.similarQuery || '';
            STATE.query = query;
            runSearch(query);
            window.scrollTo?.({ top: 0 });
        });
    });

    document.querySelectorAll('[data-saved-query]').forEach(button => {
        button.addEventListener('click', () => {
            const query = button.dataset.savedQuery || '';
            STATE.query = query;
            STATE.savedOpen = false;
            runSearch(query);
        });
    });

    document.getElementById('sticky-search-btn')?.addEventListener('click', focusSearchInput);

    document.getElementById('load-more-btn')?.addEventListener('click', () => {
        if (STATE.upgrading || !STATE.search.hasMore || STATE.search.nextOffset == null) return;
        runSearch(STATE.search.query, { append: true });
    });

    // Back from Saved to the page it was opened over: the same results (the
    // query and list are still in STATE), or the landing page.
    document.getElementById('saved-back-btn')?.addEventListener('click', () => {
        STATE.savedOpen = false;
        render();
        window.scrollTo?.({ top: 0 });
        document.getElementById('saved-toggle')?.focus({ preventScroll: true });
    });

    document.getElementById('export-anki-btn')?.addEventListener('click', event => {
        exportSavedAsAnki(event.currentTarget);
    });

    document.querySelectorAll('[data-action="bookmark"]').forEach(button => {
        button.addEventListener('click', () => {
            const result = findResultByPublicId(button.dataset.resultId, button.dataset.chengyu);
            if (result) toggleBookmark(result);
        });
    });

    document.querySelectorAll('[data-action="copy"]').forEach(button => {
        button.addEventListener('click', () => {
            const result = findResultByPublicId(button.dataset.resultId, button.dataset.chengyu);
            if (result) copyResult(result, button);
        });
    });

    document.querySelectorAll('[data-action="toggle-details"]').forEach(button => {
        button.addEventListener('click', () => toggleResultDetails(button));
    });

    document.querySelectorAll('[data-action="toggle-reveal"]').forEach(button => {
        button.addEventListener('click', () => toggleReveal(button));
    });

    document.querySelectorAll('[data-action="pronounce"]').forEach(button => {
        button.addEventListener('click', () => {
            const result = findResultByPublicId(button.dataset.resultId, button.dataset.chengyu);
            if (result) pronounceResult(result);
        });
    });

    // Dictionary tooltip event delegation
    const resultsContainer = document.querySelector('.results-wrap') || document.getElementById('app');
    if (resultsContainer) {
        resultsContainer.addEventListener('click', handleDictionaryClick);
        resultsContainer.addEventListener('keydown', handleDictionaryKeydown);
    }

    if (documentListenersBound) return;
    documentListenersBound = true;

    // Close popover when clicking outside
    document.addEventListener('click', event => {
        if (event.target.closest('[data-dict-close]')) {
            hidePopover();
            return;
        }

        // "Idioms with 屡" in a dictionary popover searches for that word.
        const dictSearch = event.target.closest('[data-dict-search]');
        if (dictSearch) {
            hidePopover();
            STATE.query = dictSearch.dataset.dictSearch || '';
            STATE.savedOpen = false;
            runSearch(STATE.query);
            window.scrollTo?.({ top: 0 });
            return;
        }

        if (!event.target.closest('[data-dict-entry]') &&
            !event.target.closest('[data-dict-char]') &&
            !event.target.closest(`#${POPOVER_ID}`)) {
            hidePopover();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') hidePopover();
    });

    let stickyFrame = 0;
    window.addEventListener?.('scroll', () => {
        if (stickyFrame) return;
        stickyFrame = (window.requestAnimationFrame || (fn => setTimeout(fn, 16)))(() => {
            stickyFrame = 0;
            updateStickySearch();
        });
    }, { passive: true });
}

// The query box grows with its text instead of offering a resize grip.
// Browsers with `field-sizing: content` do this in CSS; elsewhere the height
// is set only once the text overflows, so an empty or one-line box keeps the
// prerendered markup unchanged.
function fitSearchInput(input) {
    if (!input?.style || typeof input.scrollHeight !== 'number') return;
    if (window.CSS?.supports?.('field-sizing', 'content')) return;
    if (!input.style.height && input.scrollHeight <= input.clientHeight + 1) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}

function syncQueryFromInput() {
    const input = document.getElementById('search-input');
    if (input) {
        STATE.query = input.value;
    }
}

function findResultByPublicId(resultId, chengyu) {
    if (resultId) {
        const currentResult = STATE.results.find(result => getResultPublicId(result) === resultId);
        if (currentResult) return currentResult;
        if (STATE.bookmarks[resultId]) return STATE.bookmarks[resultId];
    }
    return STATE.results.find(result => result.chengyu === chengyu) || STATE.bookmarks[chengyu] || null;
}

function init() {
    render();
    SPEECH.getSpeechVoices().catch(() => {});
    checkBackendHealth();
    Promise.allSettled([
        loadDictionaryData(),
        refreshBookmarksIfNeeded(),
    ]).then(() => {
        render();
    });
}

document.addEventListener('DOMContentLoaded', init);

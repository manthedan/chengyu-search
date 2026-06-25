const PAGE_SIZE = 10;
const PUBLIC_GITHUB_URL = 'https://github.com/manthedan/chengyu-search';

const EXAMPLE_QUERIES = [
    {
        query: 'adding something unnecessary and ruining it',
        label: 'unnecessary addition',
        simplified: '画蛇添足',
        traditional: '畫蛇添足'
    },
    {
        query: 'pretending to be dumb to avoid answering',
        label: 'playing dumb',
        simplified: '装傻充愣',
        traditional: '裝傻充愣'
    },
    {
        query: 'quick-witted and clever',
        label: 'quick-witted',
        simplified: '聪明伶俐',
        traditional: '聰明伶俐'
    },
    {
        query: 'hesitant and unable to move forward',
        label: 'hesitant',
        simplified: '趑趄不前',
        traditional: '趑趄不前'
    },
    {
        query: 'easier said than done',
        label: 'easier said',
        simplified: '谈何容易',
        traditional: '談何容易'
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
    splitExampleText
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

const STATE = {
    theme: STORAGE.loadTheme(),
    scriptMode: STORAGE.loadScriptMode(),
    view: 'landing',
    query: '',
    loading: false,
    loadingMore: false,
    healthChecked: false,
    error: null,
    results: [],
    bookmarks: INITIAL_BOOKMARKS,
    savedOpen: Object.keys(INITIAL_BOOKMARKS).length > 0,
    speakingChengyu: null,
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
    getScriptMode: () => STATE.scriptMode
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
    if (!count) return 'No results';
    const noun = count === 1 ? 'result' : 'results';
    return STATE.search.hasMore ? `${count} ${noun} shown` : `${count} ${noun}`;
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
    return Array.from(getScriptCopy().siteTitle).map((char, index) => {
        const className = index === 2 ? 'ch accent' : 'ch';
        return `<span class="${className}">${escapeHtml(char)}</span>`;
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
    const original = button.innerHTML;
    button.classList.add('is-success');
    button.innerHTML = `<span class="action-flash-label">${escapeHtml(label)}</span>`;
    setTimeout(() => {
        button.classList.remove('is-success');
        button.innerHTML = original;
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

function updateSearchStateFromResponse(data, append = false) {
    STATE.search = {
        query: data.query,
        mode: data.mode,
        queryType: data.queryType,
        preferredMode: data.preferredMode,
        autoRouted: Boolean(data.autoRouted),
        fallbackFrom: data.fallbackFrom || null,
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
    if (!trimmed) {
        STATE.error = 'Please enter a description, Chinese characters, or pinyin.';
        render();
        return;
    }

    STATE.error = null;
    if (append) {
        STATE.loadingMore = true;
    } else {
        STATE.loading = true;
        STATE.view = 'results';
        STATE.results = [];
        STATE.search = createEmptySearchState();
    }
    render();

    try {
        const data = await API_CLIENT.search(trimmed, { offset: append ? STATE.search.nextOffset || 0 : 0 });
        updateSearchStateFromResponse(data, append);
        STATE.query = trimmed;
        STATE.view = 'results';
    } catch (error) {
        console.error('Search failed:', error);
        STATE.error = error.message;
        if (!append) {
            STATE.results = [];
            STATE.search = createEmptySearchState();
            STATE.search.query = trimmed;
        }
    } finally {
        STATE.loading = false;
        STATE.loadingMore = false;
        render();
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
            <a class="wordmark" href="#" data-home-link>
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
                <button class="saved-pill ${STATE.savedOpen ? 'active' : ''}" id="saved-toggle" title="Show saved idioms">
                    Saved <span>${bookmarkCount}</span>
                </button>
                <button class="icon-btn" id="theme-toggle" title="Toggle theme">
                    ${renderIcon(STATE.theme === 'dark' ? 'sun' : 'moon')}
                </button>
            </div>
        </header>
    `;
}

function renderHero() {
    const scriptCopy = getScriptCopy();

    return `
        <section class="hero">
            <h1 class="hero-chars">
                ${renderHeroTitleChars()}
            </h1>
            <p class="hero-sub"><em>Describe a situation, find the idiom.</em></p>
            <p class="hero-tag">Chengyu · ${escapeHtml(scriptCopy.chengyu)} · Four-character wisdom</p>
        </section>
    `;
}

function renderSearchSection() {
    return `
        <section class="search-wrap">
            <div class="search-box">
                <div class="search-row">
                    <div class="search-input-wrap">
                        ${renderIcon('search').replace('<svg', '<svg class="magnifier"')}
                        <textarea
                            class="search-input"
                            id="search-input"
                            rows="1"
                            placeholder="Describe a situation, or type 中文 / pinyin…"
                        >${escapeHtml(STATE.query)}</textarea>
                    </div>
                    <button class="search-btn" id="search-btn" ${STATE.loading ? 'disabled' : ''}>
                        ${STATE.loading ? 'Searching…' : 'Search <span class="cn">搜索</span><span class="kbd">↵</span>'}
                    </button>
                </div>
                <div class="search-footer search-footer-plain">
                    <span class="hint">tip: try a feeling, situation, relationship, or scene</span>
                </div>
            </div>
            ${STATE.view === 'landing' ? `
                <div class="examples">
                    <span class="examples-label">Try:</span>
                    ${EXAMPLE_QUERIES.map(example => `
                        <button class="chip" data-query="${escapeHtml(example.query)}">
                            ${escapeHtml(example.label)}
                            <span class="cn">${escapeHtml(getDisplayHeadword(example))}</span>
                        </button>
                    `).join('')}
                </div>
            ` : ''}
            ${STATE.error ? `<div class="message-card error-card">${escapeHtml(STATE.error)}</div>` : ''}
        </section>
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
                <div class="section-rule">Saved idioms · ${escapeHtml(getScriptCopy().savedIdioms)}</div>
                <div class="saved-toolbar">
                    <span class="saved-meta">${saved.length} ${saved.length === 1 ? 'card' : 'cards'} ready · 10-column TSV</span>
                    <button class="saved-export-btn" id="export-anki-btn" title="Download saved idioms as an Anki TSV with separate columns for headword, simplified, traditional, numbered pinyin, tone-marked pinyin, meaning, literal, example, tags, and formality">
                        ${renderIcon('download')}
                        <span>Export for Anki</span>
                    </button>
                </div>
            </div>
            <div class="saved-grid">
                ${saved.map(result => {
                    const resultId = getResultPublicId(result);
                    return `
                    <article class="saved-card" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}">
                        <button class="saved-card-main" data-saved-query="${escapeHtml(result.chengyu)}" title="Search this idiom">
                            <div class="saved-card-chars">${escapeHtml(getDisplayHeadword(result))}</div>
                            <div class="saved-card-pinyin">${escapeHtml(toneMarkPinyinString(result.pinyin))}</div>
                            <div class="saved-card-literal">&ldquo;${escapeHtml(result.literal)}&rdquo;</div>
                            <div class="saved-card-meaning">${escapeHtml(result.meaning)}</div>
                        </button>
                        <div class="saved-card-actions">
                            <button class="icon-btn card-action" data-action="pronounce" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="Pronounce">
                                ${renderIcon('volume')}
                            </button>
                            <button class="icon-btn card-action active" data-action="bookmark" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="Remove from saved">
                                ${renderIcon('bookmarkFilled')}
                            </button>
                            <button class="icon-btn card-action" data-action="copy" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="Copy idiom">
                                ${renderIcon('copy')}
                            </button>
                        </div>
                    </article>
                `;
                }).join('')}
            </div>
        </section>
    `;
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

function renderResultCard(result, index) {
    const { zh, en } = splitExampleText(result.example);
    const bookmarkIcon = isBookmarked(result) ? 'bookmarkFilled' : 'bookmark';
    const resultId = getResultPublicId(result);
    const isSpeaking = STATE.speakingChengyu === resultId;

    return `
        <article class="result-card ${index === 0 ? 'rank-1' : ''}" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}">
            <div class="hero-row">
                <div class="rank-badge">
                    <span>NO.</span>
                    <span class="num">${String(index + 1).padStart(2, '0')}</span>
                </div>
                <div class="chars-block">
                    <h3 class="result-chars">${renderCharacterCluster(result)}</h3>
                    <div class="pinyin-line">${escapeHtml(toneMarkPinyinString(result.pinyin))}</div>
                    <div class="literal-line"><span class="arrow">—</span>&ldquo;${escapeHtml(result.literal)}&rdquo;</div>
                </div>
                <div class="card-actions">
                    <button class="icon-btn card-action ${isSpeaking ? 'active' : ''}" data-action="pronounce" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="${isSpeaking ? 'Stop pronunciation' : 'Pronounce'}">
                        ${renderIcon('volume')}
                    </button>
                    <button class="icon-btn card-action ${isBookmarked(result) ? 'active' : ''}" data-action="bookmark" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="Save locally">
                        ${renderIcon(bookmarkIcon)}
                    </button>
                    <button class="icon-btn card-action" data-action="copy" data-result-id="${escapeHtml(resultId)}" data-chengyu="${escapeHtml(result.chengyu)}" title="Copy idiom">
                        ${renderIcon('copy')}
                    </button>
                </div>
            </div>
            <div class="result-body ${index === 0 ? 'hero-body' : ''}">
                <div class="field">
                    <span class="field-label">Meaning</span>
                    <span class="field-value">${escapeHtml(result.meaning)}</span>
                </div>
                <div class="field">
                    <span class="field-label">Literal</span>
                    <span class="field-value lit">${escapeHtml(result.literal)}</span>
                </div>
                <div class="field example-block">
                    <span class="field-label">In use · 例句</span>
                    <div class="example-zh">${highlightIdiomInText(zh, result)}</div>
                    ${en ? `<div class="example-en">${escapeHtml(en)}</div>` : ''}
                </div>
            </div>
            ${renderTagChips(result) ? `<div class="tags-row">${renderTagChips(result)}</div>` : ''}
        </article>
    `;
}

function renderResultsSection() {
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

    return `
        <section class="results-wrap layout-hero">
            <div class="results-head" id="results-head">
                <h2 class="results-title">
                    <span class="count">${escapeHtml(formatResultCountLabel())}</span> for <em>&ldquo;${escapeHtml(STATE.search.query)}&rdquo;</em>
                </h2>
            </div>
            <div class="results-grid">
                ${STATE.results.map((result, index) => renderResultCard(result, index)).join('')}
            </div>
            ${STATE.search.hasMore ? `
                <div class="results-actions">
                    <button id="load-more-btn" class="load-more-btn" ${STATE.loadingMore ? 'disabled' : ''}>
                        ${STATE.loadingMore ? 'Loading…' : 'Load more results'}
                    </button>
                </div>
            ` : ''}
        </section>
    `;
}

function renderFooter() {
    return `
        <footer class="foot">
            <div class="footer-copy">
                <span class="footer-title">Chengyu Search</span>
                <span class="footer-note">Search Chinese idioms by meaning, characters, or pinyin.</span>
            </div>
            <a class="footer-link" href="${PUBLIC_GITHUB_URL}" target="_blank" rel="noreferrer noopener">
                ${renderIcon('github')}
                <span>View public GitHub</span>
            </a>
        </footer>
    `;
}

function render() {
    document.body.dataset.theme = STATE.theme;

    const app = document.getElementById('app');
    const html = `
        ${renderHeader()}
        ${STATE.view === 'landing' ? renderHero() : ''}
        ${renderSearchSection()}
        ${renderSavedSection()}
        ${STATE.view === 'results' ? renderResultsSection() : ''}
        ${renderFooter()}
        ${renderPopover()}
    `;

    if (app.innerHTML.trim() !== html.trim()) {
        app.innerHTML = html;
        bind();
    }
}

function bind() {
    document.querySelector('[data-home-link]')?.addEventListener('click', event => {
        event.preventDefault();
        STATE.view = 'landing';
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
    searchInput?.addEventListener('input', event => {
        STATE.query = event.target.value;
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

    document.querySelectorAll('.chip[data-query]').forEach(chip => {
        chip.addEventListener('click', () => {
            const query = chip.dataset.query || '';
            STATE.query = query;
            runSearch(query);
        });
    });

    document.querySelectorAll('[data-saved-query]').forEach(button => {
        button.addEventListener('click', () => {
            const query = button.dataset.savedQuery || '';
            STATE.query = query;
            runSearch(query);
        });
    });

    document.getElementById('load-more-btn')?.addEventListener('click', () => {
        if (!STATE.search.hasMore || STATE.search.nextOffset == null) return;
        runSearch(STATE.search.query, { append: true });
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

    document.querySelectorAll('[data-action="pronounce"]').forEach(button => {
        button.addEventListener('click', () => {
            const result = findResultByPublicId(button.dataset.resultId, button.dataset.chengyu);
            if (result) pronounceResult(result);
        });
    });

    // Dictionary tooltip event delegation
    const resultsContainer = document.querySelector('.results-grid') || document.getElementById('app');
    if (resultsContainer) {
        resultsContainer.addEventListener('click', handleDictionaryClick);
        resultsContainer.addEventListener('keydown', handleDictionaryKeydown);
    }

    // Close popover when clicking outside
    document.addEventListener('click', event => {
        if (!event.target.closest('[data-dict-entry]') &&
            !event.target.closest('[data-dict-char]') &&
            !event.target.closest(`#${POPOVER_ID}`)) {
            hidePopover();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') hidePopover();
    });
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

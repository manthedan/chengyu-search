const API_BASE_URL = window.location.origin;
const PAGE_SIZE = 10;
const PUBLIC_GITHUB_URL = 'https://github.com/manthedan/chengyu-search';
const STORAGE_KEYS = {
    theme: 'chengyu-theme',
    bookmarks: 'chengyu-bookmarks',
    scriptMode: 'chengyu-script-mode'
};

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

const INITIAL_BOOKMARKS = loadBookmarks();

const STATE = {
    theme: loadTheme(),
    scriptMode: loadScriptMode(),
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

let activeUtterance = null;
let voicesReadyPromise = null;

function loadTheme() {
    return localStorage.getItem(STORAGE_KEYS.theme) === 'dark' ? 'dark' : 'light';
}

function loadScriptMode() {
    return localStorage.getItem(STORAGE_KEYS.scriptMode) === 'traditional' ? 'traditional' : 'simplified';
}

function normalizeBookmarkRecord(record, fallbackChengyu = '') {
    if (!record || typeof record !== 'object') {
        return null;
    }

    const chengyu = record.chengyu || fallbackChengyu;
    if (!chengyu) {
        return null;
    }

    return {
        id: typeof record.id === 'string' && record.id.length > 0 ? record.id : '',
        chengyu,
        simplified: typeof record.simplified === 'string' ? record.simplified : chengyu,
        traditional: typeof record.traditional === 'string' ? record.traditional : '',
        pinyin: typeof record.pinyin === 'string' ? record.pinyin : '',
        literal: typeof record.literal === 'string' ? record.literal : '',
        meaning: typeof record.meaning === 'string' ? record.meaning : '',
        example: typeof record.example === 'string' ? record.example : '',
        tags: Array.isArray(record.tags) ? [...record.tags] : [],
        formality: typeof record.formality === 'string' ? record.formality : ''
    };
}

function loadBookmarks() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.bookmarks) || '{}');
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed)
                .map(([key, record]) => {
                    const normalized = normalizeBookmarkRecord(record, key);
                    return [normalized?.id || key, normalized];
                })
                .filter(([, record]) => Boolean(record))
        );
    } catch {
        return {};
    }
}

function persistBookmarks() {
    localStorage.setItem(STORAGE_KEYS.bookmarks, JSON.stringify(STATE.bookmarks));
}

function createEmptySearchState() {
    return {
        query: '',
        mode: null,
        queryType: null,
        preferredMode: null,
        autoRouted: false,
        fallbackFrom: null,
        loadedCount: 0,
        hasMore: false,
        nextOffset: null
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TONE_MARKS = { 1: '\u0304', 2: '\u0301', 3: '\u030C', 4: '\u0300', 5: '' };
const VOWEL_PRIORITY = ['a', 'o', 'e', 'iu', 'ui', 'i', 'u', 'ü'];

function toToneMarkedSyllable(syllable) {
    const match = String(syllable || '').match(/^([a-züv:]+)([1-5])$/i);
    if (!match) return syllable;

    let [, base, tone] = match;
    base = base.toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');

    let index = -1;
    if (base.includes('a')) index = base.indexOf('a');
    else if (base.includes('o')) index = base.indexOf('o');
    else if (base.includes('e')) index = base.indexOf('e');
    else if (base.includes('iu')) index = base.indexOf('u');
    else if (base.includes('ui')) index = base.indexOf('i');
    else {
        for (const vowel of ['i', 'u', 'ü']) {
            const candidateIndex = base.indexOf(vowel);
            if (candidateIndex >= 0) {
                index = candidateIndex;
                break;
            }
        }
    }

    if (index < 0) return base;
    return `${base.slice(0, index + 1)}${TONE_MARKS[Number(tone)]}${base.slice(index + 1)}`;
}

function toneMarkPinyinString(pinyin) {
    return String(pinyin || '').replace(/[a-züv:]+[1-5]/gi, token => toToneMarkedSyllable(token));
}

function extractToneMarkedPinyinSyllables(pinyin) {
    const tokens = String(pinyin || '').match(/[a-züv:]+[1-5]?/gi) || [];
    return tokens.map(token => toToneMarkedSyllable(token));
}

function containsChineseCharacter(char) {
    return /[\u3400-\u9fff]/.test(char);
}

function buildCharacterPins(chengyu, pinyin) {
    const syllables = extractToneMarkedPinyinSyllables(pinyin);
    let syllableIndex = 0;

    return Array.from(String(chengyu || '')).map(char => {
        if (!containsChineseCharacter(char)) {
            return { char, pin: '', punctuation: true };
        }
        const pin = syllables[syllableIndex] || '';
        syllableIndex += 1;
        return { char, pin, punctuation: false };
    });
}

function splitExampleText(example) {
    const text = String(example || '').trim();
    if (!text) {
        return { zh: '', en: '' };
    }

    const match = text.match(/^(.*?)(?:[（(]([^()（）]+)[）)])?\s*$/);
    if (!match) {
        return { zh: text, en: '' };
    }

    return {
        zh: (match[1] || '').trim(),
        en: (match[2] || '').trim()
    };
}

function getExampleDisplayText(text, result) {
    const rawText = String(text || '');
    const canonicalIdiom = result?.chengyu;
    const displayIdiom = result ? getDisplayHeadword(result) : '';

    if (!rawText || !canonicalIdiom || !displayIdiom || canonicalIdiom === displayIdiom) {
        return rawText;
    }

    return rawText.split(canonicalIdiom).join(displayIdiom);
}

function highlightIdiomInText(text, result) {
    const displayText = getExampleDisplayText(text, result);
    const displayIdiom = result ? getDisplayHeadword(result) : '';
    const escaped = escapeHtml(displayText);
    if (!displayText || !displayIdiom) return escaped;

    const pattern = new RegExp(escapeRegExp(escapeHtml(displayIdiom)), 'g');
    return escaped.replace(pattern, '<span class="highlight">$&</span>');
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
    return Boolean(STATE.bookmarks[getResultPublicId(result)] || STATE.bookmarks[result.chengyu]);
}

function saveBookmark(result) {
    STATE.bookmarks[getResultPublicId(result)] = normalizeBookmarkRecord(result, result.chengyu);
    STATE.savedOpen = true;
    persistBookmarks();
}

function removeBookmark(result) {
    delete STATE.bookmarks[getResultPublicId(result)];
    if (result.id && result.chengyu) {
        delete STATE.bookmarks[result.chengyu];
    }
    if (Object.keys(STATE.bookmarks).length === 0) {
        STATE.savedOpen = false;
    }
    persistBookmarks();
}

function toggleBookmark(result) {
    if (isBookmarked(result)) {
        removeBookmark(result);
    } else {
        saveBookmark(result);
    }
    render();
}

function normalizeSpeechLang(lang) {
    return String(lang || '').toLowerCase().replace(/_/g, '-');
}

function scoreChineseVoice(voice) {
    const lang = normalizeSpeechLang(voice.lang);
    const name = String(voice.name || '').toLowerCase();

    let score = 0;
    if (lang === 'zh-cn' || lang.startsWith('cmn-cn') || lang.startsWith('zh-hans')) {
        score += 100;
    } else if (lang.startsWith('zh') || lang.startsWith('cmn')) {
        score += 70;
    } else {
        return -Infinity;
    }

    if (name.includes('mandarin') || name.includes('普通话')) score += 20;
    if (name.includes('ting-ting') || name.includes('tingting')) score += 10;
    if (name.includes('mei-jia') || name.includes('meijia')) score += 8;
    if (name.includes('sin-ji') || name.includes('sinji')) score += 5;
    if (name.includes('google')) score += 4;
    if (voice.localService) score += 3;
    if (voice.default) score += 2;
    if (lang.startsWith('zh-hk') || lang.startsWith('zh-tw')) score -= 5;

    return score;
}

function getSpeechVoices() {
    if (!('speechSynthesis' in window)) {
        return Promise.resolve([]);
    }

    const current = window.speechSynthesis.getVoices();
    if (current.length > 0) {
        return Promise.resolve(current);
    }

    if (!voicesReadyPromise) {
        voicesReadyPromise = new Promise(resolve => {
            let settled = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                resolve(window.speechSynthesis.getVoices());
            };

            const onVoicesChanged = () => {
                window.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
                finish();
            };

            window.speechSynthesis.addEventListener?.('voiceschanged', onVoicesChanged);
            setTimeout(() => {
                window.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
                finish();
            }, 1000);
        });
    }

    return voicesReadyPromise;
}

async function pickBestChineseVoice() {
    const voices = await getSpeechVoices();
    return voices
        .map(voice => ({ voice, score: scoreChineseVoice(voice) }))
        .filter(entry => entry.score > -Infinity)
        .sort((a, b) => b.score - a.score)[0]?.voice || null;
}

function clearSpeakingState({ rerender = true } = {}) {
    if (!STATE.speakingChengyu) return;
    STATE.speakingChengyu = null;
    if (rerender) render();
}

async function pronounceResult(result) {
    if (!('speechSynthesis' in window)) {
        STATE.error = 'Browser speech synthesis is not available on this device.';
        render();
        return;
    }

    const resultId = getResultPublicId(result);
    if (STATE.speakingChengyu === resultId) {
        window.speechSynthesis.cancel();
        activeUtterance = null;
        clearSpeakingState();
        return;
    }

    try {
        const voice = await pickBestChineseVoice();
        if (!voice) {
            STATE.error = 'No suitable Chinese voice is available in this browser. Try a browser or system voice set with Mandarin support.';
            render();
            return;
        }

        STATE.error = null;
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(result.chengyu);
        activeUtterance = utterance;
        utterance.voice = voice;
        utterance.lang = voice.lang || 'zh-CN';
        utterance.rate = 0.72;
        utterance.pitch = 1;

        utterance.onstart = () => {
            STATE.speakingChengyu = resultId;
            render();
        };

        utterance.onend = () => {
            if (activeUtterance !== utterance) {
                return;
            }
            activeUtterance = null;
            clearSpeakingState();
        };

        utterance.onerror = error => {
            console.error('Pronunciation failed:', error);
            if (activeUtterance !== utterance) {
                return;
            }
            activeUtterance = null;
            clearSpeakingState({ rerender: false });
            STATE.error = 'Unable to pronounce this idiom in the browser right now.';
            render();
        };

        window.speechSynthesis.speak(utterance);
    } catch (error) {
        console.error('Pronunciation failed:', error);
        activeUtterance = null;
        clearSpeakingState({ rerender: false });
        STATE.error = 'Unable to pronounce this idiom in the browser right now.';
        render();
    }
}

function getDisplayHeadword(result) {
    if (STATE.scriptMode === 'traditional') {
        return result.traditional || result.chengyu;
    }
    return result.simplified || result.chengyu;
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
        const response = await fetch(`${API_BASE_URL}/api/health`);
        const data = await response.json();
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

async function performSearchRequest(query, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            offset,
            limit: PAGE_SIZE
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Search failed');
    }

    return response.json();
}

function bookmarkNeedsRefresh(record) {
    return !record?.id || !record?.simplified || !record?.traditional || !record?.example || !record?.formality || !Array.isArray(record?.tags) || record.tags.length === 0;
}

async function fetchBookmarkSearchResult(record) {
    const chengyu = record.chengyu;
    const response = await fetch(`${API_BASE_URL}/api/search/keyword`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: chengyu, limit: 10, offset: 0 })
    });

    if (!response.ok) {
        throw new Error('Bookmark refresh failed');
    }

    const data = await response.json();
    return data.results?.find(result => record.id && result.id === record.id)
        || data.results?.find(result => result.chengyu === chengyu)
        || data.results?.[0]
        || null;
}

async function refreshBookmarksIfNeeded() {
    const staleEntries = Object.entries(STATE.bookmarks).filter(([, record]) => bookmarkNeedsRefresh(record));
    if (!staleEntries.length) {
        return false;
    }

    let changed = false;

    await Promise.all(staleEntries.map(async ([key, record]) => {
        try {
            const refreshed = await fetchBookmarkSearchResult(record);
            if (!refreshed) {
                return;
            }

            const normalized = normalizeBookmarkRecord(refreshed, record.chengyu);
            const newKey = normalized.id || key;
            if (newKey !== key) {
                delete STATE.bookmarks[key];
            }
            STATE.bookmarks[newKey] = {
                ...record,
                ...normalized
            };
            changed = true;
        } catch (error) {
            console.warn('Unable to refresh saved idiom metadata:', record.chengyu, error);
        }
    }));

    if (changed) {
        persistBookmarks();
    }

    return changed;
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
        const data = await performSearchRequest(trimmed, append ? STATE.search.nextOffset || 0 : 0);
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

    return `
        <header class="site-header">
            <a class="wordmark" href="#" data-home-link>
                <div class="seal">成</div>
                <div class="titles">
                    <div class="cn">成语搜索</div>
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
    return `
        <section class="hero">
            <h1 class="hero-chars">
                <span class="ch">成</span><span class="ch">语</span><span class="ch accent">搜</span><span class="ch">索</span>
            </h1>
            <p class="hero-sub"><em>Describe a situation, find the idiom.</em></p>
            <p class="hero-tag">Chengyu · 成语 · Four-character wisdom</p>
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
    return Object.values(STATE.bookmarks).sort((a, b) => a.chengyu.localeCompare(b.chengyu, 'zh-Hans-CN'));
}

function sanitizeAnkiField(value) {
    return escapeHtml(String(value ?? ''))
        .replace(/\t/g, ' ')
        .replace(/\r?\n+/g, '<br>');
}

function buildAnkiFieldColumns(result) {
    return [
        sanitizeAnkiField(getDisplayHeadword(result)),
        sanitizeAnkiField(result.simplified || result.chengyu),
        sanitizeAnkiField(result.traditional || result.chengyu),
        sanitizeAnkiField(result.pinyin || ''),
        sanitizeAnkiField(toneMarkPinyinString(result.pinyin)),
        sanitizeAnkiField(result.meaning || ''),
        sanitizeAnkiField(result.literal || ''),
        sanitizeAnkiField(result.example || ''),
        sanitizeAnkiField(Array.isArray(result.tags) ? result.tags.join(', ') : ''),
        sanitizeAnkiField(result.formality || '')
    ];
}

function buildAnkiExportContent(results) {
    const rows = results.map(result => buildAnkiFieldColumns(result).join('\t'));

    return [
        '#separator:tab',
        '#html:true',
        ...rows
    ].join('\n');
}

function downloadTextFile({ filename, content, type }) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
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
    downloadTextFile({
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
                <div class="section-rule">Saved idioms · 已存成语</div>
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
    const pins = buildCharacterPins(getDisplayHeadword(result), result.pinyin);
    return pins.map(item => {
        if (item.punctuation) {
            return `<span class="ch punct">${escapeHtml(item.char)}</span>`;
        }

        return `
            <span class="ch">
                <span class="pin">${escapeHtml(item.pin)}</span>${escapeHtml(item.char)}
            </span>
        `;
    }).join('');
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
    app.innerHTML = `
        ${renderHeader()}
        ${STATE.view === 'landing' ? renderHero() : ''}
        ${renderSearchSection()}
        ${renderSavedSection()}
        ${STATE.view === 'results' ? renderResultsSection() : ''}
        ${renderFooter()}
    `;

    bind();
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
        localStorage.setItem(STORAGE_KEYS.scriptMode, STATE.scriptMode);
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
        localStorage.setItem(STORAGE_KEYS.theme, STATE.theme);
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
    getSpeechVoices().catch(() => {});
    checkBackendHealth();
    refreshBookmarksIfNeeded().then(changed => {
        if (changed) {
            render();
        }
    }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);

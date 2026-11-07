(function attachFrontendStorage(global) {
    'use strict';

    const DEFAULT_STORAGE_KEYS = {
        theme: 'chengyu-theme',
        bookmarks: 'chengyu-bookmarks',
        scriptMode: 'chengyu-script-mode',
        charHintSeen: 'chengyu-char-hint-seen'
    };

    function createFrontendStorage({ storage = global.localStorage || globalThis.localStorage, keys = DEFAULT_STORAGE_KEYS, normalizeBookmarkRecord } = {}) {
        if (!normalizeBookmarkRecord) {
            throw new Error('normalizeBookmarkRecord is required');
        }

        function loadTheme() {
            return storage.getItem(keys.theme) === 'dark' ? 'dark' : 'light';
        }

        function persistTheme(theme) {
            storage.setItem(keys.theme, theme === 'dark' ? 'dark' : 'light');
        }

        function loadScriptMode() {
            return storage.getItem(keys.scriptMode) === 'traditional' ? 'traditional' : 'simplified';
        }

        function persistScriptMode(scriptMode) {
            storage.setItem(keys.scriptMode, scriptMode === 'traditional' ? 'traditional' : 'simplified');
        }

        // Whether the reader has opened a character popover, which retires
        // the "Tap a character" hint. Without storage the hint keeps showing.
        function loadCharHintSeen() {
            try {
                return storage.getItem(keys.charHintSeen || DEFAULT_STORAGE_KEYS.charHintSeen) === '1';
            } catch {
                return false;
            }
        }

        function persistCharHintSeen() {
            try {
                storage.setItem(keys.charHintSeen || DEFAULT_STORAGE_KEYS.charHintSeen, '1');
            } catch { /* the hint simply returns on the next visit */ }
        }

        function loadBookmarks() {
            try {
                const parsed = JSON.parse(storage.getItem(keys.bookmarks) || '{}');
                if (!parsed || typeof parsed !== 'object') {
                    return {};
                }

                const aliases = global.ChengyuBookmarkIdMigrations?.aliases || {};
                const corpusVersion = global.ChengyuBookmarkIdMigrations?.corpusVersion;
                const bookmarks = Object.create(null);
                const canonicalSources = new Set();
                let changed = false;
                for (const [key, record] of Object.entries(parsed)) {
                    const normalized = normalizeBookmarkRecord(record, key);
                    if (!normalized) continue;
                    const oldId = normalized.id || key;
                    const id = Object.hasOwn(aliases, oldId) ? aliases[oldId] : oldId;
                    // Storage keys already carry sense identity in partial saves. Restore
                    // it before refresh; a Chinese headword key is not an ID.
                    if (id !== oldId || (!normalized.id && /^chengyu_[a-f0-9]{16}$/.test(id))) {
                        normalized.id = id;
                        normalized.needsRefresh = true;
                        changed = true;
                    }
                    if (corpusVersion && normalized.corpusVersion !== corpusVersion) {
                        normalized.needsRefresh = true;
                        changed = true;
                    }
                    // An already-current save wins over an obsolete duplicate,
                    // regardless of storage order. Distinct sense IDs stay apart.
                    if (!bookmarks[id] || !canonicalSources.has(id)) bookmarks[id] = normalized;
                    if (id === oldId) canonicalSources.add(id);
                    if (id !== key) changed = true;
                }
                if (Object.keys(bookmarks).length !== Object.keys(parsed).length) changed = true;
                if (changed) {
                    // Keep the in-memory migration even when local storage is full.
                    try { persistBookmarks(bookmarks); } catch { /* retry on next load */ }
                }
                return bookmarks;
            } catch {
                return {};
            }
        }

        function persistBookmarks(bookmarks) {
            storage.setItem(keys.bookmarks, JSON.stringify(bookmarks || {}));
        }

        return {
            loadTheme,
            persistTheme,
            loadScriptMode,
            persistScriptMode,
            loadBookmarks,
            persistBookmarks,
            loadCharHintSeen,
            persistCharHintSeen
        };
    }

    global.ChengyuFrontendStorage = {
        DEFAULT_STORAGE_KEYS,
        createFrontendStorage
    };
})(window);

(function attachFrontendStorage(global) {
    'use strict';

    const DEFAULT_STORAGE_KEYS = {
        theme: 'chengyu-theme',
        bookmarks: 'chengyu-bookmarks',
        scriptMode: 'chengyu-script-mode'
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

        function loadBookmarks() {
            try {
                const parsed = JSON.parse(storage.getItem(keys.bookmarks) || '{}');
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

        function persistBookmarks(bookmarks) {
            storage.setItem(keys.bookmarks, JSON.stringify(bookmarks || {}));
        }

        return {
            loadTheme,
            persistTheme,
            loadScriptMode,
            persistScriptMode,
            loadBookmarks,
            persistBookmarks
        };
    }

    global.ChengyuFrontendStorage = {
        DEFAULT_STORAGE_KEYS,
        createFrontendStorage
    };
})(window);

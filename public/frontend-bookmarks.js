(function attachFrontendBookmarks(global) {
    'use strict';

    function createBookmarkHelpers({
        normalizeBookmarkRecord,
        getResultPublicId,
        storage,
        apiClient,
        consoleRef = global.console
    } = {}) {
        if (!normalizeBookmarkRecord || !getResultPublicId || !storage || !apiClient) {
            throw new Error('normalizeBookmarkRecord, getResultPublicId, storage, and apiClient are required');
        }

        function persistBookmarks(bookmarks) {
            storage.persistBookmarks(bookmarks);
        }

        function isBookmarked(bookmarks, result) {
            return Boolean(bookmarks[getResultPublicId(result)] || bookmarks[result.chengyu]);
        }

        function saveBookmark(state, result) {
            state.bookmarks[getResultPublicId(result)] = normalizeBookmarkRecord(result, result.chengyu);
            state.savedOpen = true;
            persistBookmarks(state.bookmarks);
        }

        function removeBookmark(state, result) {
            delete state.bookmarks[getResultPublicId(result)];
            if (result.id && result.chengyu) {
                delete state.bookmarks[result.chengyu];
            }
            if (Object.keys(state.bookmarks).length === 0) {
                state.savedOpen = false;
            }
            persistBookmarks(state.bookmarks);
        }

        function toggleBookmark(state, result) {
            if (isBookmarked(state.bookmarks, result)) {
                removeBookmark(state, result);
            } else {
                saveBookmark(state, result);
            }
        }

        function getBookmarkedResults(bookmarks) {
            return Object.values(bookmarks).sort((a, b) => a.chengyu.localeCompare(b.chengyu, 'zh-Hans-CN'));
        }

        function bookmarkNeedsRefresh(record) {
            return !record?.id || !record?.simplified || !record?.traditional || !record?.example || !record?.formality || !Array.isArray(record?.tags) || record.tags.length === 0;
        }

        async function refreshBookmarksIfNeeded(state) {
            const staleEntries = Object.entries(state.bookmarks).filter(([, record]) => bookmarkNeedsRefresh(record));
            if (!staleEntries.length) {
                return false;
            }

            let changed = false;

            await Promise.all(staleEntries.map(async ([key, record]) => {
                try {
                    const refreshed = await apiClient.fetchBookmarkSearchResult(record);
                    if (!refreshed) {
                        return;
                    }

                    const normalized = normalizeBookmarkRecord(refreshed, record.chengyu);
                    const newKey = normalized.id || key;
                    if (newKey !== key) {
                        delete state.bookmarks[key];
                    }
                    state.bookmarks[newKey] = {
                        ...record,
                        ...normalized
                    };
                    changed = true;
                } catch (error) {
                    consoleRef.warn('Unable to refresh saved idiom metadata:', record.chengyu, error);
                }
            }));

            if (changed) {
                persistBookmarks(state.bookmarks);
            }

            return changed;
        }

        return {
            persistBookmarks,
            isBookmarked,
            saveBookmark,
            removeBookmark,
            toggleBookmark,
            getBookmarkedResults,
            bookmarkNeedsRefresh,
            refreshBookmarksIfNeeded
        };
    }

    global.ChengyuFrontendBookmarks = {
        createBookmarkHelpers
    };
})(window);

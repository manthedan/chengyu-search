(function attachFrontendApi(global) {
    'use strict';

    function createChengyuApiClient({ baseUrl = global.location?.origin || '', pageSize = 10, fetchImpl = (global.fetch || globalThis.fetch).bind(global) } = {}) {
        async function parseJsonResponse(response, fallbackMessage) {
            let data = null;
            try {
                data = await response.json();
            } catch {
                data = null;
            }

            if (!response.ok) {
                throw new Error(data?.error || fallbackMessage);
            }

            return data;
        }

        async function fetchHealth() {
            const response = await fetchImpl(`${baseUrl}/api/health`);
            return parseJsonResponse(response, 'Health check failed');
        }

        async function search(query, { offset = 0, limit = pageSize } = {}) {
            const response = await fetchImpl(`${baseUrl}/api/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, offset, limit })
            });

            return parseJsonResponse(response, 'Search failed');
        }

        async function keywordSearch(query, { offset = 0, limit = 10 } = {}) {
            const response = await fetchImpl(`${baseUrl}/api/search/keyword`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit, offset })
            });

            return parseJsonResponse(response, 'Bookmark refresh failed');
        }

        async function fetchBookmarkSearchResult(record) {
            const chengyu = record.chengyu;
            const data = await keywordSearch(chengyu, { limit: 10, offset: 0 });
            return data.results?.find(result => record.id && result.id === record.id)
                || data.results?.find(result => result.chengyu === chengyu)
                || data.results?.[0]
                || null;
        }

        return {
            fetchHealth,
            search,
            keywordSearch,
            fetchBookmarkSearchResult
        };
    }

    global.ChengyuFrontendApi = {
        createChengyuApiClient
    };
})(window);

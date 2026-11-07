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

        async function search(query, { offset = 0, limit = pageSize, signal } = {}) {
            const response = await fetchImpl(`${baseUrl}/api/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, offset, limit }), signal
            });

            return parseJsonResponse(response, 'Search failed');
        }

        async function followHosted(query, initial, { offset = 0, limit = pageSize, signal, pollMs = 700, maxWaitMs = 10000 } = {}) {
            if (!initial.hostedRequestId) return initial;
            const controller = new AbortController();
            const cancel = () => controller.abort();
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            const deadline = setTimeout(cancel, maxWaitMs);
            try {
                while (!controller.signal.aborted) {
                    await new Promise((resolve, reject) => {
                        const aborted = () => { clearTimeout(timer); reject(new Error('Search cancelled')); };
                        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); }, pollMs);
                        controller.signal.addEventListener('abort', aborted, { once: true });
                        if (controller.signal.aborted) aborted();
                    });
                    const response = await fetchImpl(`${baseUrl}/api/search/status`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query, offset, limit, hostedRequestId: initial.hostedRequestId }), signal: controller.signal
                    });
                    const data = await parseJsonResponse(response, 'Search status failed');
                    if (controller.signal.aborted) break;
                    if (data.status !== 'pending') return data;
                }
            } catch {
                // A bounded continuation never retries the ordinary search URL.
            } finally {
                clearTimeout(deadline); signal?.removeEventListener('abort', cancel);
            }
            return { status: 'unavailable', message: 'Description search is temporarily unavailable. Try an English description, an exact idiom, or pinyin lookup.' };
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
            const results = data.results || [];
            if (record.id) return results.find(result => result.id === record.id) || null;
            const matches = results.filter(result => result.chengyu === chengyu && (!record.pinyin || result.pinyin === record.pinyin));
            // An old headword-only bookmark cannot identify an ambiguous sense.
            return matches.length === 1 ? matches[0] : null;
        }

        return {
            fetchHealth,
            search,
            followHosted,
            keywordSearch,
            fetchBookmarkSearchResult
        };
    }

    global.ChengyuFrontendApi = {
        createChengyuApiClient
    };
})(window);

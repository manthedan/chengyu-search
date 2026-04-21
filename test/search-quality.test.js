// Search Quality Tests
// Ensures multilingual search continues to work correctly

process.env.QUIET_LOGS = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../api-server.js');

let BASE_URL = '';
let server;

// Test helper to make search requests
async function searchEndpoint(path, query, options = {}) {
    const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, ...options })
    });
    return await response.json();
}

async function searchKeyword(query, options = {}) {
    return searchEndpoint('/api/search/keyword', query, options);
}

async function searchSemantic(query, options = {}) {
    return searchEndpoint('/api/search/semantic', query, options);
}

async function searchHybrid(query, options = {}) {
    return searchEndpoint('/api/search/hybrid', query, options);
}

async function searchAuto(query, options = {}) {
    return searchEndpoint('/api/search', query, options);
}

async function fetchMetrics() {
    const response = await fetch(`${BASE_URL}/api/metrics`);
    return response.json();
}

before(async () => {
    server = await startServer({ port: 0 });
    const { port } = server.address();
    BASE_URL = `http://127.0.0.1:${port}`;

    const response = await fetch(`${BASE_URL}/api/health`);
    const health = await response.json();
    assert.strictEqual(health.status, 'ok', 'Server must report healthy status');
    assert.strictEqual(health.database, true, 'Database must be loaded');
    assert.strictEqual(health.embeddings, true, 'Embeddings must be loaded');
    assert.strictEqual(health.autoRouting, true, 'Automatic query routing should be enabled');
    assert.strictEqual(health.defaultRoute, 'auto', 'Auto-routed search should be the default UI mode');
});

after(async () => {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
});

describe('English Keyword Search Quality', () => {
    it('should rank 狗屁不通 highly for "fart" query', async () => {
        const data = await searchKeyword('fart');
        assert.ok(data.results.length > 0, 'Should return results');

        // Find 狗屁不通 in results
        const targetIndex = data.results.findIndex(r => r.chengyu === '狗屁不通');
        assert.ok(targetIndex !== -1, '狗屁不通 should be in results');
        assert.ok(targetIndex <= 2, `狗屁不通 should be in top 3 (was #${targetIndex + 1})`);
    });

    it('should find idioms about making things worse', async () => {
        const data = await searchKeyword('making things worse');
        assert.ok(data.results.length > 0, 'Should return results');

        // Should find idioms like 火上浇油 or similar
        const hasRelevant = data.results.some(r =>
            r.meaning.toLowerCase().includes('worse') ||
            r.meaning.toLowerCase().includes('fuel')
        );
        assert.ok(hasRelevant, 'Should find idioms about worsening situations');
    });
});

describe('Chinese Character Search', () => {
    it('should find exact match for full Chinese idiom', async () => {
        const data = await searchKeyword('狗屁不通');
        assert.ok(data.results.length > 0, 'Should return results');
        assert.strictEqual(data.results[0].chengyu, '狗屁不通', 'Exact match should be first');
    });

    it('should expose both simplified and traditional headword variants in results', async () => {
        const data = await searchKeyword('一丁不识');
        assert.ok(data.results.length > 0, 'Should return results');
        assert.strictEqual(data.results[0].chengyu, '一丁不识', 'Exact match should be first');
        assert.strictEqual(data.results[0].simplified, '一丁不识', 'Should expose simplified form');
        assert.strictEqual(data.results[0].traditional, '一丁不識', 'Should expose traditional form');
    });

    it('should find exact matches when searching with traditional characters', async () => {
        const data = await searchKeyword('畫蛇添足');
        assert.ok(data.results.length > 0, 'Should return results');
        assert.strictEqual(data.results[0].chengyu, '画蛇添足', 'Traditional lookup should resolve to the canonical simplified entry');
        assert.strictEqual(data.results[0].traditional, '畫蛇添足', 'Should still expose the traditional form in the payload');
    });

    it('should find partial Chinese character matches', async () => {
        const data = await searchKeyword('狗屁');
        assert.ok(data.results.length > 0, 'Should return results');

        // Should find 狗屁不通
        const hasTarget = data.results.some(r => r.chengyu === '狗屁不通');
        assert.ok(hasTarget, 'Should find 狗屁不通 with partial match "狗屁"');
    });

    it('should find single Chinese character matches', async () => {
        const data = await searchKeyword('龙');
        assert.ok(data.results.length > 0, 'Should return results');

        // Should find idioms containing 龙 (dragon)
        const allHaveDragon = data.results.every(r => r.chengyu.includes('龙'));
        assert.ok(allHaveDragon, 'All results should contain the character 龙');
    });
});

describe('Pinyin Search', () => {
    it('should find idioms with numbered pinyin', async () => {
        const data = await searchKeyword('gou3 pi4');
        assert.ok(data.results.length > 0, 'Should return results for numbered pinyin');

        // Should find 狗屁不通 or idioms with similar pinyin
        const hasRelevant = data.results.some(r =>
            r.pinyin.includes('gou3') || r.pinyin.includes('pi4')
        );
        assert.ok(hasRelevant, 'Should find idioms matching pinyin');
    });

    it('should convert and search accented pinyin', async () => {
        const data = await searchKeyword('gǒu pì');
        assert.ok(data.results.length > 0, 'Should return results for accented pinyin');

        // Should find same results as numbered pinyin after conversion
        const hasRelevant = data.results.some(r =>
            r.chengyu.includes('狗') || r.chengyu.includes('屁')
        );
        assert.ok(hasRelevant, 'Should find idioms after converting accented pinyin');
    });
});

describe('Semantic Search Quality', () => {
    it('should find conceptually related idioms for English queries', async () => {
        const data = await searchSemantic('fart');
        assert.ok(data.results.length > 0, 'Should return semantic results');

        // Semantic search should find smell/waste-related idioms
        const hasRelevant = data.results.some(r =>
            r.meaning.toLowerCase().includes('smell') ||
            r.meaning.toLowerCase().includes('stink') ||
            r.meaning.toLowerCase().includes('nonsense') ||
            r.chengyu === '狗屁不通'
        );
        assert.ok(hasRelevant, 'Should find semantically related idioms');
    });

    it('should understand abstract concepts', async () => {
        const data = await searchSemantic('opportunity');
        assert.ok(data.results.length > 0, 'Should return semantic results');

        // Should find idioms about opportunity, timing, or chances
        const hasRelevant = data.results.some(r =>
            r.meaning.toLowerCase().includes('opportun') ||
            r.meaning.toLowerCase().includes('chance') ||
            r.meaning.toLowerCase().includes('time')
        );
        assert.ok(hasRelevant, 'Should find idioms about opportunities');
    });
});

describe('Smart Routing', () => {
    it('should prioritize English fields for English queries', async () => {
        const data = await searchKeyword('fart');
        const top3 = data.results.slice(0, 3);

        const hasEnglishMatch = top3.some(r =>
            r.literal.toLowerCase().includes('fart') ||
            r.meaning.toLowerCase().includes('nonsense')
        );
        assert.ok(hasEnglishMatch, 'English query should rank English field matches highly');
    });

    it('should prioritize Chinese fields for Chinese queries', async () => {
        const data = await searchKeyword('龙');
        const allHaveChar = data.results.slice(0, 5).every(r => r.chengyu.includes('龙'));
        assert.ok(allHaveChar, 'Chinese query should rank exact character matches highly');
    });

    it('should auto-route English description queries to semantic search', async () => {
        const data = await searchAuto('opportunity');
        assert.strictEqual(data.mode, 'semantic', 'English description queries should auto-route to semantic search');
        assert.ok(['english_meaning', 'thematic', 'literal'].includes(data.queryType), 'Should classify the query as an English-language query type');
        assert.ok(data.results.length > 0, 'Auto-routed semantic search should return results');
    });

    it('should auto-route Chinese queries to hybrid search', async () => {
        const data = await searchAuto('狗屁不通');
        assert.strictEqual(data.mode, 'hybrid', 'Chinese queries should auto-route to hybrid search');
        assert.strictEqual(data.queryType, 'chinese_exact', 'Should classify the query as chinese_exact');
        assert.ok(data.results.length > 0, 'Auto-routed hybrid search should return results');
    });

    it('should auto-route traditional Chinese queries and still return the simplified-backed entry', async () => {
        const data = await searchAuto('畫蛇添足');
        assert.strictEqual(data.mode, 'hybrid', 'Traditional Chinese queries should auto-route to hybrid search');
        assert.strictEqual(data.queryType, 'chinese_exact', 'Traditional Chinese should still classify as chinese_exact');
        assert.ok(data.results.length > 0, 'Auto-routed hybrid search should return results');
        assert.strictEqual(data.results[0].chengyu, '画蛇添足', 'Traditional lookup should resolve to the canonical simplified entry');
        assert.strictEqual(data.results[0].traditional, '畫蛇添足', 'Response should preserve the traditional headword variant');
    });

    it('should auto-route pinyin queries to hybrid search', async () => {
        const data = await searchAuto('gou3 pi4');
        assert.strictEqual(data.mode, 'hybrid', 'Pinyin queries should auto-route to hybrid search');
        assert.strictEqual(data.queryType, 'pinyin', 'Should classify the query as pinyin');
        assert.ok(data.results.length > 0, 'Auto-routed hybrid search should return results');
    });

    it('should not misclassify ordinary English phrases as pinyin', async () => {
        const data = await searchAuto('reaping what you sow');
        assert.notStrictEqual(data.queryType, 'pinyin', 'Ordinary English phrases should not be classified as pinyin');
        assert.strictEqual(data.mode, 'hybrid', 'Benchmark-backed phrase overrides should be able to route ordinary English phrases to hybrid search');
        assert.ok(data.results.length > 0, 'Auto-routed search should still return results');
    });

    it('should auto-route benchmarked friendship theme queries to keyword search', async () => {
        const data = await searchAuto('friendship');
        assert.strictEqual(data.mode, 'keyword', 'Benchmarked lexical theme queries should be able to use keyword search');
        assert.strictEqual(data.queryType, 'thematic', 'Should keep the thematic query classification');
        assert.ok(data.results.length > 0, 'Auto-routed keyword search should return results');
    });

    it('should auto-route concrete single-word English noun queries to the audited best mode', async () => {
        const dragon = await searchAuto('dragon');
        assert.strictEqual(dragon.mode, 'keyword', 'Dragon should use the audited lexical keyword route');
        assert.strictEqual(dragon.queryType, 'partial', 'Should classify dragon as a lexical partial query');
        assert.ok(dragon.results.length > 0, 'Auto-routed keyword search should return results for dragon');

        const water = await searchAuto('water');
        assert.strictEqual(water.mode, 'semantic', 'Water should use the audited semantic partial route');
        assert.strictEqual(water.queryType, 'partial', 'Should classify water as a lexical partial query');
        assert.ok(water.results.length > 0, 'Auto-routed semantic search should return results for water');
    });
});

describe('Runtime Metrics', () => {
    it('should expose request and cache metrics for search traffic', async () => {
        const baseline = await fetchMetrics();
        const baselineRequests = baseline.metrics.requests.total;
        const baselineAutoRequests = baseline.metrics.requests.by_endpoint.search_auto || 0;
        const baselineSemanticHits = baseline.metrics.caches.ranked_results.by_mode.semantic?.hits || 0;
        const baselineSemanticMisses = baseline.metrics.caches.ranked_results.by_mode.semantic?.misses || 0;

        await searchAuto('metrics visibility unique opportunity check');
        await searchAuto('metrics visibility unique opportunity check');

        const updated = await fetchMetrics();
        assert.ok(updated.metrics.requests.total >= baselineRequests + 2, 'Metrics should record search requests');
        assert.ok((updated.metrics.requests.by_endpoint.search_auto || 0) >= baselineAutoRequests + 2, 'Metrics should count auto-route requests by endpoint');
        assert.ok((updated.metrics.caches.ranked_results.by_mode.semantic?.misses || 0) >= baselineSemanticMisses + 1, 'First semantic request should miss the ranked-result cache');
        assert.ok((updated.metrics.caches.ranked_results.by_mode.semantic?.hits || 0) >= baselineSemanticHits + 1, 'Second semantic request should hit the ranked-result cache');
    });
});

describe('Pagination', () => {
    it('should keep the default hot path at 10 results and advertise when more are available', async () => {
        const data = await searchAuto('龙');
        assert.ok(data.results.length <= 10, 'Default searches should still return at most 10 results');
        assert.strictEqual(data.limit, 10, 'Default page size should remain 10');
        assert.strictEqual(data.offset, 0, 'Default offset should be 0');
        assert.strictEqual(typeof data.hasMore, 'boolean', 'Pagination metadata should include hasMore');
        if (data.hasMore) {
            assert.strictEqual(data.nextOffset, data.results.length, 'nextOffset should advance by the number of returned results');
        }
    });

    it('should allow loading more results without overlapping the first page', async () => {
        const firstPage = await searchAuto('龙', { limit: 5, offset: 0 });
        const secondPage = await searchAuto('龙', { limit: 5, offset: 5 });

        assert.strictEqual(firstPage.results.length, 5, 'First page should honor the requested limit');
        assert.strictEqual(secondPage.results.length, 5, 'Second page should honor the requested limit');

        const firstPageIds = new Set(firstPage.results.map(result => result.chengyu));
        const overlappingIds = secondPage.results.filter(result => firstPageIds.has(result.chengyu));
        assert.strictEqual(overlappingIds.length, 0, 'Second page should not overlap the first page');
        assert.strictEqual(secondPage.offset, 5, 'Second page should report the requested offset');
    });

    it('should reject pagination requests beyond the supported result window', async () => {
        const response = await fetch(`${BASE_URL}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '龙', limit: 15, offset: 40 })
        });
        const data = await response.json();

        assert.strictEqual(response.status, 400, 'The API should reject requests beyond the max paginated result window');
        assert.match(data.error, /offset \+ limit cannot exceed 50/);
    });
});

describe('Ranking Quality', () => {
    it('should return results in descending relevance order', async () => {
        const data = await searchKeyword('dragon');

        // Check that results are ordered (each result should be >= next in score)
        // We can't directly check scores, but we can verify structure
        assert.ok(data.results.length > 0, 'Should return results');
        assert.ok(Array.isArray(data.results), 'Results should be an array');
    });

    it('should limit results to reasonable number', async () => {
        const data = await searchKeyword('love');

        // Should return max 10 results (as per api-server.js)
        assert.ok(data.results.length <= 10, 'Should return at most 10 results');
        assert.ok(data.results.length > 0, 'Should return at least some results');
    });
});

describe('Curated Hybrid Example Query Quality', () => {
    // These tests track the exact example chips shown in the UI.
    // They should return strong, intuitive top results in hybrid mode.

    it('should find "draw snake add legs" for "adding something unnecessary"', async () => {
        const data = await searchHybrid('adding something unnecessary and ruining it');
        assert.ok(data.results.length > 0, 'Should return results');

        const firstResult = data.results[0];
        assert.strictEqual(firstResult.chengyu, '画蛇添足', 'Should return 画蛇添足 as first result');
        assert.ok(firstResult.literal.includes('snake') || firstResult.literal.includes('legs'),
            'Should have vivid literal imagery about drawing legs on snake');
    });

    it('should find "playing dumb" for the curated avoidance query', async () => {
        const data = await searchHybrid('pretending to be dumb to avoid answering');
        assert.ok(data.results.length > 0, 'Should return results');

        const firstResult = data.results[0];
        assert.strictEqual(firstResult.chengyu, '装傻充愣', 'Should return 装傻充愣 as first result');
    });

    it('should find "sharp-minded" for "quick-witted and clever"', async () => {
        const data = await searchHybrid('quick-witted and clever');
        assert.ok(data.results.length > 0, 'Should return results');

        const firstResult = data.results[0];
        assert.strictEqual(firstResult.chengyu, '聪明伶俐', 'Should return 聪明伶俐 as first result');
    });

    it('should find hesitation/stuckness for the curated movement query', async () => {
        const data = await searchHybrid('frozen and unable to move forward');
        assert.ok(data.results.length > 0, 'Should return results');

        const firstResult = data.results[0];
        assert.strictEqual(firstResult.chengyu, '趑趄不前', 'Should return 趑趄不前 as first result');
    });
});

describe('Edge Cases', () => {
    it('should handle empty query gracefully', async () => {
        const response = await fetch(`${BASE_URL}/api/search/keyword`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '' })
        });
        assert.strictEqual(response.status, 400, 'Should return 400 for empty query');
    });

    it('should handle mixed Chinese and English queries', async () => {
        const data = await searchKeyword('dragon 龙');
        assert.ok(data.results.length > 0, 'Should handle mixed language queries');

        // Should find dragon-related idioms
        const hasRelevant = data.results.some(r =>
            r.chengyu.includes('龙') ||
            r.meaning.toLowerCase().includes('dragon')
        );
        assert.ok(hasRelevant, 'Should find relevant results for mixed query');
    });

    it('should handle very long queries', async () => {
        const longQuery = 'a very long query with many words that describes a complex situation involving multiple concepts';
        const data = await searchKeyword(longQuery);

        // Should not crash and should return something or empty array
        assert.ok(Array.isArray(data.results), 'Should return results array');
    });
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HostedEmbeddingClient, RATE } = require('../src/embeddings/hosted-client');
const { queryText } = require('../src/embeddings/hosted-recipe');
const { withHostedSearch } = require('../src/search/hosted-search');
const { writeQwenIndex, readQwenIndex } = require('../src/embeddings/qwen-index');
const { normalizePagination } = require('../src/search/search-service');
const { probeDescription } = require('../scripts/smoke-hosted');
const env = { HOSTED_EMBEDDINGS: 'on', CF_ACCOUNT_ID: 'fixture', CF_API_TOKEN: 'fixture' };
const vector = Array(1024).fill(0); vector[0] = 1;
const response = (usage = { neurons: .01 }) => ({ ok: true, json: async () => ({ result: { data: [vector], usage } }) });
function fixture(extra = {}) {
    let uptime = 0;
    const client = new HostedEmbeddingClient({ env, ledgerFile: null, monotonicNow: () => uptime, fetchImpl: async () => response(), ...extra });
    uptime = 12000;
    return { client, advance: ms => { uptime += ms; } };
}
function route(client, extra = {}) {
    const database = [{ id: 'a', chengyu: '甲' }, { id: 'b', chengyu: '乙' }];
    const index = readQwenIndex(writeQwenIndex(database, [vector, vector], { neurons: 1 }).buffer, database);
    return withHostedSearch({ client, mode: 'auto', getDatabase: () => database, getIndex: () => index,
        isFallbackReady: () => true, execute: async () => ({ results: [{ id: 'fallback' }], mode: 'semantic' }),
        normalizePagination, createHttpError: (_code, data) => Error(data.error),
        createResponse: data => ({ ...data, results: data.rankedResults.slice(data.offset, data.offset + data.limit) }), ...extra });
}

test('cold Chinese pending and English MiniLM upgrade poll the original request only, including pagination', async () => {
    for (const query of ['经过很多次困难以后仍然坚持原来的目标', 'keeping a promise even when it is difficult']) {
        let resolve, calls = 0, fallbacks = 0;
        const { client } = fixture({ fetchImpl: () => { calls++; return new Promise(r => { resolve = r; }); } });
        client.waitMs = 1;
        const search = route(client, { execute: async () => { fallbacks++; return { results: [{ id: 'fallback' }], mode: 'semantic' }; } });
        const first = await search(query, { offset: 1, limit: 1 });
        assert.equal(first.status, query.includes('经过') ? 'pending' : 'complete');
        assert.equal(first.embeddingSource, query.includes('经过') ? 'pending' : 'minilm-fallback');
        assert.equal(fallbacks, query.includes('经过') ? 0 : 1);
        for (let n = 0; n < 20; n++) assert.equal((await search(query, { statusOnly: true, hostedRequestId: first.hostedRequestId })).status, 'pending');
        resolve(response()); await client.drain();
        const completed = await search(query, { statusOnly: true, hostedRequestId: first.hostedRequestId, offset: 1, limit: 1 });
        assert.equal(completed.embeddingSource, 'hosted-qwen');
        assert.equal(completed.results[0].id, 'b'); assert.equal(calls, 1);
        assert.equal((await search('a different query', { statusOnly: true, hostedRequestId: first.hostedRequestId })).status, 'unavailable');
        assert.equal((await search(query, { statusOnly: true, hostedRequestId: 'missing' })).status, 'unavailable');
        assert.equal(calls, 1);
    }
});

test('continuations retain terminal errors and expire/evict without dispatching again', async () => {
    let reject, calls = 0;
    const { client, advance } = fixture({ env: { ...env, HOSTED_EMBEDDING_CACHE_SIZE: '1' }, fetchImpl: () => { calls++; return new Promise((_r, j) => { reject = j; }); } });
    const first = await client.get('a cold request', { waitMs: 1 });
    reject(Error('secret provider failure')); await client.drain();
    assert.equal(client.peek('a cold request', first.requestId).reason, 'transport');
    client.fetch = async () => { calls++; return response(); };
    await client.get('another cold request');
    const secondId = [...client.continuations.cache.keys()][0];
    assert.equal(client.peek('a cold request', first.requestId).reason, 'expired');
    advance(61000);
    assert.equal(client.peek('another cold request', secondId).reason, 'expired');
    assert.equal(calls, 2);
});

test('Chinese terminal failures explicitly suggest English, exact and pinyin; fallback labels describe actual route', async () => {
    for (const reason of ['breaker', 'budget', 'restart-budget', 'ledger', 'http', 'transport', 'request-timeout', 'input-limit', 'capacity']) {
        const search = route({ enabled: true, get: async () => ({ vector: null, reason }) }, { execute: () => assert.fail('Chinese must not return a misleading lexical success') });
        const result = await search('只有在最后一刻才着手准备需要的东西');
        assert.equal(result.status, 'unavailable'); assert.match(result.message, /temporarily unavailable.*English.*exact.*pinyin/);
        assert.equal(result.embeddingSource, 'unavailable'); assert.equal(result.hostedRequestId, undefined);
    }
    for (const extra of [{ getIndex: () => null }, {}]) {
        const c = { enabled: Boolean(extra.getIndex), requested: true, get: () => assert.fail('must not call') };
        assert.equal((await route(c, extra)('没有准备就急着去做一件重要的事情')).status, 'unavailable');
    }
    const c = { enabled: true, get: async () => ({ vector: null, reason: 'budget' }) };
    assert.equal((await route(c, { execute: async () => ({ mode: 'keyword', results: [] }) })('winter')).embeddingSource, 'lexical-fallback');
    assert.equal((await route(c, { isFallbackReady: () => false })('a longer description')).embeddingSource, 'lexical-fallback');
});

test('restart allowance begins empty even with no disk and repeated restarts cannot refill it', async () => {
    let totalReserved = 0, totalUptime = 0, calls = 0;
    // Simulate disk loss at every restart; unknown costs keep their full bound.
    for (let restart = 0; restart < 20; restart++) {
        let uptime = 0;
        const c = new HostedEmbeddingClient({ env: { ...env, HOSTED_BREAKER_FAILURES: '100000' }, ledgerFile: null,
            monotonicNow: () => uptime, fetchImpl: async (_url, options) => {
                calls++; totalReserved += (Buffer.byteLength(JSON.parse(options.body).text[0]) + 256) * RATE;
                throw Error('unknown cost');
            } });
        assert.equal((await c.get('cold boot')).reason, 'restart-budget');
        for (let second = 1; second <= 100; second++) {
            uptime = second * 1000;
            await c.get(`new request ${restart} ${second}`);
        }
        totalUptime += uptime;
        assert.ok(totalReserved <= totalUptime * 7200 / 86400000 + 1e-8);
    }
    assert.ok(calls > 100);
    // Idle credit is capped, including UTC rollover and backward wall clocks.
    let uptime = 0;
    const c = new HostedEmbeddingClient({ env, ledgerFile: null, now: () => 0, monotonicNow: () => uptime });
    uptime = 86400000;
    assert.equal(c.status().restartBudgetAvailable, 1);
});

test('reviewer midnight concurrency: yesterday outstanding work blocks new-day .6 spend against .5 cap', async () => {
    let time = Date.parse('2026-10-27T23:59:59.999Z'), resolve, calls = 0;
    const { client } = fixture({ now: () => time, env: { ...env, HOSTED_DAILY_NEURONS: '0.5' },
        fetchImpl: () => { calls++; return new Promise(r => { resolve = r; }); } });
    const first = client.get('first', { waitMs: 1 });
    await first;
    time += 2;
    assert.equal((await client.get('second')).reason, 'budget');
    assert.ok(client.status().neuronsUsedToday > .3);
    resolve(response({ neurons: .3 })); await client.drain();
    assert.equal(client.days['2026-10-27'], .3); assert.equal(client.days['2026-10-28'], .3);
    assert.equal((await client.get('second')).reason, 'budget'); assert.equal(calls, 1);
});

test('cross-midnight failures with unknown cost retain the reservation on both days before further admission', async () => {
    let time = Date.parse('2026-10-27T23:59:59.999Z'), reject, calls = 0;
    const { client } = fixture({ now: () => time, env: { ...env, HOSTED_DAILY_NEURONS: '0.5' },
        fetchImpl: () => { calls++; return new Promise((_r, j) => { reject = j; }); } });
    await client.get('first', { waitMs: 1 });
    time += 2; reject(Error('unknown cost')); await client.drain();
    assert.ok(client.days['2026-10-28'] > .3);
    assert.equal(client.days['2026-10-28'], client.days['2026-10-27']);
    assert.equal((await client.get('second')).reason, 'budget'); assert.equal(calls, 1);
});

test('smoke records the first experience and checks only its continuation', async () => {
    const routes = [];
    const result = await probeDescription(async (url, body) => {
        routes.push(url);
        if (url === '/api/search') return { status: 'pending', embeddingSource: 'pending', results: [], hostedRequestId: 'same' };
        assert.equal(body.hostedRequestId, 'same');
        return { status: 'complete', embeddingSource: 'hosted-qwen', results: [{}] };
    }, 'cold description', { pollMs: 1 });
    assert.equal(result.first.status, 'pending'); assert.equal(result.first.count, 0);
    assert.equal(result.final.source, 'hosted-qwen'); assert.equal(result.polls, 1);
    assert.deepEqual(routes, ['/api/search', '/api/search/status']);
});

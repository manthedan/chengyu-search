'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostedEmbeddingClient, readCredentials } = require('../src/embeddings/hosted-client');
const { queryText, queryKey, RECIPE_HASH, unitVector } = require('../src/embeddings/hosted-recipe');
const { writeQwenIndex, readQwenIndex, scanQwen } = require('../src/embeddings/qwen-index');
const { isHostedDescription, withHostedSearch, matchStrength, WEAK_MATCH_Z } = require('../src/search/hosted-search');
const { normalizePagination } = require('../src/search/search-service');
const vector = Array(1024).fill(0); vector[0] = 1;
const env = { HOSTED_EMBEDDINGS: 'on', CF_ACCOUNT_ID: 'fixture-account', CF_API_TOKEN: 'fixture-token' };
const ok = () => ({ ok: true, json: async () => ({ success: true, result: { data: [vector], usage: { neurons: .01 } } }) });
function client(options = {}) {
    let elapsed = 0;
    const c = new HostedEmbeddingClient({ env, ledgerFile: null, fetchImpl: async () => ok(), monotonicNow: () => elapsed, ...options });
    elapsed = 12000; // Production starts empty; these fixtures begin after startup accrual.
    c.advanceBudget = ms => { elapsed += ms; };
    return c;
}

test('flag requires explicit on and both credentials; no network when off', async () => {
    for (const config of [{}, { ...env, HOSTED_EMBEDDINGS: 'off' }, { ...env, CF_API_TOKEN: '' }]) {
        const c = client({ env: config, fetchImpl: () => { throw Error('must not call'); } });
        assert.equal((await c.get('patient effort')).reason, 'off'); assert.equal(c.status().status, 'off');
    }
});
test('request uses one exact prefix; cache identity preserves English semantics and normalization', async () => {
    let calls = 0;
    const c = client({ fetchImpl: async (_url, opts) => { calls++; assert.deepEqual(JSON.parse(opts.body), { text: [queryText('  patient effort  ')] }); return ok(); } });
    assert.equal((await c.get('  patient effort  ')).reason, 'success');
    assert.equal((await c.get('patient effort')).reason, 'cache'); assert.equal(calls, 1);
    assert.notEqual(queryKey(queryText('happy')), queryKey(queryText('not happy')));
    assert.equal(queryText('他著書立說，希望人們能過上安寧生活'), queryText('他著书立说，希望人们能过上安宁生活'));
    assert.match(RECIPE_HASH, /^[a-f\d]{64}$/);
});
test('wait timeout falls back promptly while one deduplicated request fills the bounded LRU', async () => {
    let resolve, calls = 0;
    const c = client({ env: { ...env, HOSTED_EMBEDDING_CACHE_SIZE: '1' }, fetchImpl: async () => { calls++; return new Promise(r => { resolve = r; }); } });
    const one = c.get('slow description', { waitMs: 5 }), two = c.get('slow description', { waitMs: 5 });
    assert.equal((await one).reason, 'timeout'); assert.equal((await two).reason, 'timeout'); assert.equal(calls, 1);
    resolve(ok()); await c.drain(); assert.equal((await c.get('slow description')).reason, 'cache');
    c.fetch = async () => ok(); await c.get('another description');
    assert.equal(c.status().cacheSize, 1);
    assert.equal(c.cache.get(queryKey(queryText('slow description'))), null);
});
test('failures open the breaker, permit a single recovery probe, then close', async () => {
    let time = Date.now(), calls = 0;
    const c = client({ now: () => time, env: { ...env, HOSTED_BREAKER_COOLDOWN_MS: '10', HOSTED_BREAKER_FAILURES: '2' },
        fetchImpl: async () => { calls++; throw Error('transport'); } });
    await c.get('first'); await c.get('second');
    assert.equal((await c.get('third')).reason, 'breaker'); assert.equal(calls, 2);
    time += 11; c.advanceBudget(12000); let resolve;
    c.fetch = async () => new Promise(r => { resolve = r; });
    const probe = c.get('probe', { waitMs: 50 });
    assert.equal((await c.get('second probe')).reason, 'breaker');
    resolve(ok()); await probe;
    assert.equal(c.status().breaker, 'closed');
});
test('budget reserves before I/O, retains unknown costs, and recovers on the next UTC day', async () => {
    let time = Date.parse('2026-10-27T12:00:00Z'), calls = 0;
    const c = client({ now: () => time, env: { ...env, HOSTED_DAILY_NEURONS: '0.5' }, fetchImpl: async () => { calls++; throw Error(); } });
    await c.get('description');
    assert.ok(c.status().neuronsUsedToday > 0);
    assert.equal((await c.get('another description')).reason, 'budget'); assert.equal(calls, 1);
    time += 86400000; c.fetch = async () => ok();
    assert.equal((await c.get('another description')).reason, 'success');
});
test('invalid vectors, long inputs, capacity, and hard request timeouts safely fall back', async () => {
    const c = client({ fetchImpl: async () => ({ ok: true, json: async () => ({ result: { data: [[NaN]] } }) }) });
    assert.equal((await c.get('description')).reason, 'invalid-response'); assert.equal(c.status().cacheSize, 0);
    assert.equal((await c.get('字'.repeat(500))).reason, 'input-limit');
    const slow = client({ env: { ...env, HOSTED_MAX_INFLIGHT: '1', HOSTED_EMBEDDING_TIMEOUT_MS: '10' },
        fetchImpl: async (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(Error('secret error')))) });
    const pending = slow.get('first', { waitMs: 50 });
    assert.equal((await slow.get('second')).reason, 'capacity');
    assert.equal((await pending).reason, 'request-timeout');
    assert.throws(() => unitVector(Array(1024).fill(0)), /Invalid/);
});
test('provider errors and health never expose token, authorization, account or echoed error data', async () => {
    const token = 'fixture-sensitive-token', account = 'fixture-sensitive-account';
    for (const fetchImpl of [async () => { throw Error(`Authorization: Bearer ${token}; ${account}`); },
        async () => ({ ok: false, status: 401, body: { cancel: async () => {} }, json: async () => ({ Authorization: token }) }),
        async () => ({ ok: true, json: async () => { throw Error(token); } })]) {
        const c = client({ env: { ...env, CF_API_TOKEN: token, CF_ACCOUNT_ID: account }, fetchImpl });
        const result = JSON.stringify({ response: await c.get('description'), health: c.status() });
        for (const sensitive of [token, account, 'Authorization', 'Bearer']) assert.ok(!result.includes(sensitive));
    }
});
test('ledger persists reservations, fails closed on corrupt data, and credentials parse without evaluation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-test-'));
    try {
        const ledgerFile = path.join(dir, 'usage.json');
        const c = client({ ledgerFile }); await c.get('description');
        assert.equal(client({ ledgerFile }).status().neuronsUsedToday, .01);
        assert.ok(!fs.readFileSync(ledgerFile, 'utf8').includes(env.CF_API_TOKEN));
        fs.writeFileSync(ledgerFile, 'bad'); assert.equal((await client({ ledgerFile }).get('description')).reason, 'ledger');
        const creds = path.join(dir, 'credentials');
        fs.writeFileSync(creds, `export CF_ACCOUNT_ID='${'a'.repeat(32)}'\nCF_API_TOKEN="fixture_token"\n`);
        assert.equal(readCredentials(creds).CF_API_TOKEN, 'fixture_token');
        fs.writeFileSync(creds, 'CF_API_TOKEN=$(touch /tmp/must-not-run)');
        assert.throws(() => readCredentials(creds), /Invalid runtime/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('int8 artifact validates identities, corpus, recipe, payload and unit norms; cosine ranking agrees', () => {
    const database = [{ id: 'a', chengyu: '甲', meaning: 'first' }, { id: 'b', chengyu: '乙', meaning: 'second' }];
    const v2 = [...vector]; v2[0] = 0; v2[1] = 1;
    const { buffer } = writeQwenIndex(database, [vector, v2], { neurons: 1 });
    const index = readQwenIndex(buffer, database);
    assert.deepEqual(scanQwen(index, vector).map(r => r.id), ['a', 'b']);
    assert.ok(Math.abs(scanQwen(index, vector)[0].score - 1) < 1e-6);
    assert.throws(() => readQwenIndex(buffer, [{ ...database[0], meaning: 'changed' }, database[1]]), /validation/);
    const corrupt = Buffer.from(buffer); corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => readQwenIndex(corrupt, database), /integrity/);
    const altered = Buffer.from(buffer.toString('binary').replace(RECIPE_HASH, '0'.repeat(64)), 'binary');
    assert.throws(() => readQwenIndex(altered, database), /recipe/);
});
test('hosted routing preserves headwords, traditional spellings, short Chinese and pinyin', () => {
    const database = [{ chengyu: '画蛇添足', simplified: '画蛇添足', traditional: '畫蛇添足' }];
    for (const q of ['画蛇添足', ' 畫蛇添足 ', 'hua she tian zu', 'huà shé tiān zú', '蛇']) assert.equal(isHostedDescription(q, database), false, q);
    for (const q of ['extra work makes things worse', '做了多余的事反而把事情弄糟了']) assert.equal(isHostedDescription(q, database), true, q);
});
test('timed-out empty fallback stays pending and cannot mask a later hosted success, including pagination', async () => {
    let available = false, fallbacks = 0;
    const database = [{ id: 'a', chengyu: '甲' }], { buffer } = writeQwenIndex(database, [vector], { neurons: 1 });
    const execute = withHostedSearch({ execute: async () => { fallbacks++; return { results: [] }; }, mode: 'auto',
        client: { enabled: true, get: async () => available ? { vector } : { vector: null, reason: 'timeout', requestId: 'fixture' } },
        getIndex: () => readQwenIndex(buffer, database), getDatabase: () => database, isFallbackReady: () => true,
        normalizePagination, createHttpError: (_code, body) => Error(body.error), createResponse: opts => opts });
    const first = await execute('a description');
    assert.equal(first.status, 'pending'); assert.equal(first.embeddingSource, 'pending');
    available = true;
    const result = await execute('a description', { limit: 1, offset: 0 });
    assert.equal(result.embeddingSource, 'hosted-qwen'); assert.equal(result.rankedResults[0].id, 'a'); assert.equal(fallbacks, 1);
    await assert.rejects(execute('a description', { limit: 0 }), /positive integer/);
});

test('scanQwen reports corpus score stats without changing the ranking; matchStrength flags a top result that barely stands out', () => {
    const database = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, chengyu: '甲乙丙丁'[i], meaning: id }));
    const rows = [0, 1, 2, 3].map(i => { const v = Array(1024).fill(0); v[i] = 1; return v; });
    const index = readQwenIndex(writeQwenIndex(database, rows, { neurons: 1 }).buffer, database);
    const stats = {};
    assert.deepEqual(scanQwen(index, vector, 2, null, stats), scanQwen(index, vector, 2));
    assert.ok(Math.abs(stats.mean - 0.25) < 1e-6 && Math.abs(stats.std - Math.sqrt(0.1875)) < 1e-6);
    assert.equal(matchStrength([{ score: 0.25 + WEAK_MATCH_Z * 0.1 + 0.01 }], { mean: 0.25, std: 0.1 }), 'normal');
    assert.equal(matchStrength([{ score: 0.25 + WEAK_MATCH_Z * 0.1 - 0.01 }], { mean: 0.25, std: 0.1 }), 'weak');
    assert.equal(matchStrength([], { mean: 0, std: 1 }), 'weak');
});

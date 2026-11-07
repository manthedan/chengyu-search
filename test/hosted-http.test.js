'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('full server: first Chinese pending, English fallback, status upgrades, and hard failure never redispatch', async () => {
    process.env.QUIET_LOGS = '1'; process.env.HOSTED_EMBEDDINGS = 'on';
    process.env.CF_ACCOUNT_ID = 'fixture'; process.env.CF_API_TOKEN = 'fixture';
    // Read the normal artifacts/model, but no ledger, remote model downloads,
    // or real provider. Use one CPU thread in this integration fixture.
    const ort = require('onnxruntime-node'), create = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = (data, options) => create(data, { ...options, executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
    const transformers = await import('@xenova/transformers');
    transformers.env.allowRemoteModels = false;
    const api = require('../api-server');
    const client = api.hostedClient;
    client.ledgerFile = null; client.days = {}; client.refilledAt -= 12000; client.waitMs = 1;
    let calls = 0, complete;
    const vector = Array(1024).fill(0); vector[0] = 1;
    client.fetch = () => { calls++; return new Promise(resolve => { complete = () => resolve({ ok: true,
        json: async () => ({ result: { data: [vector], usage: { neurons: .01 } } }) }); }); };
    const server = await api.startServer({ port: 0 });
    const post = async (url, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        assert.equal(response.status, 200); return response.json();
    };
    try {
        for (const query of ['总是在事情已经发生以后才急忙补救', 'offering thoughtful help without expecting a reward', 'on the up and up']) {
            const before = calls;
            const first = await post('/api/search', { query });
            const pendingExpected = query.includes('总是') || query === 'on the up and up';
            assert.equal(first.status, pendingExpected ? 'pending' : 'complete');
            assert.equal(first.embeddingSource, pendingExpected ? 'pending' : 'minilm-fallback');
            if (pendingExpected) assert.equal(first.results.length, 0);
            else assert.ok(first.results.length);
            const pending = await post('/api/search/status', { query, hostedRequestId: first.hostedRequestId });
            assert.equal(pending.status, 'pending'); assert.equal(calls, before + 1);
            complete(); await client.drain();
            const done = await post('/api/search/status', { query, hostedRequestId: first.hostedRequestId });
            assert.equal(done.embeddingSource, 'hosted-qwen'); assert.ok(done.results.length);
            assert.equal(calls, before + 1);
        }
        client.timeoutMs = 10;
        client.fetch = (_url, options) => { calls++; return new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(Error('private provider failure')))); };
        const query = '到处听到的消息让他始终拿不定主意';
        const first = await post('/api/search', { query });
        assert.equal(first.status, 'pending'); await client.drain();
        const before = calls;
        const failed = await post('/api/search/status', { query, hostedRequestId: first.hostedRequestId });
        assert.equal(failed.status, 'unavailable'); assert.equal(failed.hostedFallbackReason, 'request-timeout');
        assert.match(failed.message, /English.*exact.*pinyin/); assert.equal(calls, before);
        assert.equal((await post('/api/search/status', { query, hostedRequestId: 'unknown' })).status, 'unavailable');
        assert.equal(calls, before);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

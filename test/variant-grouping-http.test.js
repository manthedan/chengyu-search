'use strict';
// Full server wiring for variant grouping: the fixture map, the
// VARIANT_GROUPING=0 switch, and the response shape over HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'variant-families.json');
const MO_XIANG = ['盲人摸象', '瞎子摸象', '众盲摸象'];

// Runs in a child so each server reads its own environment at startup.
function serverRun(env, requests) {
    const script = `
        const api = require(${JSON.stringify(path.join(__dirname, '..', 'api-server.js'))});
        (async () => {
            const server = await api.startServer({ port: 0 });
            const base = 'http://127.0.0.1:' + server.address().port;
            const out = { health: await (await fetch(base + '/api/health')).json(), responses: [] };
            for (const [url, body] of ${JSON.stringify(requests)}) {
                const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                out.responses.push(await response.json());
            }
            server.close();
            process.stdout.write('\\n' + JSON.stringify(out));
        })().catch(error => { console.error(error); process.exit(1); });`;
    const stdout = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, QUIET_LOGS: '1', SKIP_MINILM: '1', HOSTED_EMBEDDINGS: 'off', ...env }, encoding: 'utf8'
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
}

const REQUESTS = [
    ['/api/search', { query: '摸象', limit: 10 }],
    ['/api/search/keyword', { query: '摸象', limit: 10 }],
    ['/api/search/hybrid', { query: 'mo xiang', limit: 50 }],
    ['/api/search', { query: '众盲摸象', limit: 10 }],
    ['/api/search/keyword', { query: '百家争鸣', limit: 10 }]
];

test('grouping on (fixture map): one form per family on every route, each result lists its family', () => {
    const { health, responses } = serverRun({ VARIANT_FAMILIES_FILE: FIXTURE }, REQUESTS);
    assert.deepEqual(health.variantGrouping, { active: true, version: 'variants-test-fixture' });
    for (const response of responses) {
        assert.ok(response.results.length, response.query);
        assert.ok(response.results.every(r => Array.isArray(r.variants)), response.query);
        assert.ok(response.results.filter(r => MO_XIANG.includes(r.simplified)).length <= 1, response.query);
    }
    const [auto, keyword, hybrid, exact, couplet] = responses;
    for (const response of [auto, keyword, hybrid]) {
        const kept = response.results.find(r => MO_XIANG.includes(r.simplified));
        assert.deepEqual(kept.variants.map(v => v.simplified).sort(), MO_XIANG.filter(f => f !== kept.simplified).sort());
        assert.ok(kept.variants.every(v => v.relation === 'same' && v.publicId && v.traditional && v.pinyin));
    }
    assert.equal(exact.results[0].simplified, '众盲摸象');
    assert.equal(exact.results[0].traditional, '眾盲摸象');
    assert.equal(couplet.results[0].simplified, '百家争鸣');
    assert.deepEqual(couplet.results[0].variants.map(v => [v.simplified, v.relation]), [['百花齐放，百家争鸣', 'full_form']]);
});

test('VARIANT_GROUPING=0 serves the ungrouped ranking with empty variants', () => {
    const { health, responses } = serverRun({ VARIANT_FAMILIES_FILE: FIXTURE, VARIANT_GROUPING: '0' }, REQUESTS.slice(0, 2));
    assert.deepEqual(health.variantGrouping, { active: false, version: null });
    for (const response of responses) {
        assert.ok(response.results.filter(r => MO_XIANG.includes(r.simplified)).length > 1);
        assert.ok(response.results.every(r => Array.isArray(r.variants) && r.variants.length === 0));
    }
});

test('a missing map file means grouping is off, never a crash', () => {
    const { health, responses } = serverRun({ VARIANT_FAMILIES_FILE: path.join(__dirname, 'fixtures', 'no-such-map.json') }, REQUESTS.slice(1, 2));
    assert.equal(health.variantGrouping.active, false);
    assert.ok(responses[0].results.length > 1);
});

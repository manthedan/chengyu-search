#!/usr/bin/env node
'use strict';
// Checks that every landing example card returns its idiom as the #1 result.
// Follows hosted continuations, so against production it audits the hosted
// ranking; against a server without hosted embeddings it audits the fallback.
//
//   npm run audit:examples -- --url https://findchengyu.com
//   npm run audit:examples -- --url http://localhost:3000
const { loadExampleQueries } = require('./build-landing-shell');

async function rankExample(baseUrl, example, { fetchImpl = fetch, pollMs = 700, maxPolls = 20 } = {}) {
    const post = (route, body) => fetchImpl(`${baseUrl}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(response => response.json());
    const request = { query: example.query, offset: 0, limit: 10 };
    let data = await post('/api/search', request);
    for (let poll = 0; data.hostedRequestId && poll < maxPolls; poll++) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        const next = await post('/api/search/status', { ...request, hostedRequestId: data.hostedRequestId });
        if (next.status === 'pending') continue;
        if (next.embeddingSource === 'hosted-qwen') data = next;
        break;
    }
    const headwords = (data.results || []).map(result => result.simplified || result.chengyu);
    return { ...example, rank: headwords.indexOf(example.simplified) + 1, source: data.embeddingSource || data.mode, top: headwords.slice(0, 3) };
}

async function auditExamples(baseUrl, options) {
    const results = [];
    for (const example of loadExampleQueries()) results.push(await rankExample(baseUrl, example, options));
    return results;
}

if (require.main === module) {
    const urlIndex = process.argv.indexOf('--url');
    const baseUrl = (urlIndex > 0 && process.argv[urlIndex + 1]) || 'http://localhost:3000';
    auditExamples(baseUrl.replace(/\/$/, '')).then(results => {
        for (const r of results) {
            console.log(`${r.rank === 1 ? '✓' : '✗'} #${r.rank || '-'} ${r.simplified}  [${r.source}]  "${r.query}"  → ${r.top.join(' ')}`);
        }
        const failed = results.filter(r => r.rank !== 1);
        if (failed.length) {
            console.error(`\n${failed.length} example card(s) no longer return their idiom first.`);
            process.exit(1);
        }
    }).catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { rankExample, auditExamples };

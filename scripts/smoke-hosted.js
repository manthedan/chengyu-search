#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
async function probeDescription(request, query, { pollMs = 700, maxWaitMs = 10000 } = {}) {
    const start = performance.now();
    let body = await request('/api/search', { query });
    const first = { ms: performance.now() - start, status: body.status || 'complete',
        source: body.embeddingSource || body.mode, count: body.results?.length || 0, reason: body.hostedFallbackReason };
    const requestId = body.hostedRequestId;
    const deadline = performance.now() + maxWaitMs;
    let polls = 0;
    if (requestId) {
        assert.ok(first.status === 'pending' || first.count > 0, 'Cold search must be explicitly pending or have fallback results');
        while (performance.now() + pollMs < deadline) {
            await new Promise(r => setTimeout(r, pollMs));
            polls++;
            try {
                body = await request('/api/search/status', { query, hostedRequestId: requestId }, Math.max(1, deadline - performance.now()));
            } catch {
                body = { status: 'unavailable', embeddingSource: 'unavailable', hostedFallbackReason: 'status-unavailable' };
            }
            if (body.status !== 'pending') break;
        }
        if (body.status === 'pending') body = { status: 'unavailable', embeddingSource: 'unavailable', hostedFallbackReason: 'continuation-timeout' };
    }
    return { query, first, final: { ms: performance.now() - start, status: body.status || 'complete',
        source: body.embeddingSource || body.mode, count: body.results?.length || 0, reason: body.hostedFallbackReason }, polls };
}
async function smoke(baseUrl, expected = 'on') {
    const request = async (route, body, timeoutMs = 20000) => {
        const response = await fetch(baseUrl.replace(/\/+$/,'') + route, { method: body ? 'POST' : 'GET',
            ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.ceil(timeoutMs)) });
        assert.ok(response.ok, `HTTP ${response.status} at ${route}`);return response.json();
    };
    const health = await request('/api/health');
    assert.equal(health.status,'ok');assert.equal(health.hostedEmbeddings?.status,expected);
    if(expected==='on')assert.equal(health.hostedEmbeddings.artifactReady,true,'Hosted artifact must validate');
    const checks=[];
    for(const [query,first] of [['画蛇添足','画蛇添足'],['畫蛇添足','画蛇添足'],['hua she tian zu','画蛇添足']]) {
        const body=await request('/api/search',{query});assert.equal(body.results[0]?.chengyu,first);
        assert.equal(body.mode,'hybrid');checks.push({query,first,mode:body.mode});
    }
    const descriptions=expected==='on'?['patiently persisting despite repeated setbacks','遇到挫折以后仍然坚持努力不放弃']:['patiently persisting despite repeated setbacks'];
    for(const query of descriptions) {
        const check = await probeDescription(request, query);
        if(expected==='on')assert.equal(check.final.source,'hosted-qwen',`Hosted query unavailable: ${JSON.stringify(check)}`);
        assert.ok(check.final.count,`Expected description results: ${JSON.stringify(check)}`);
        checks.push(check);
    }
    return {ok:true,health,checks};
}
if(require.main===module) {
    const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
    smoke(arg('--url')||process.env.SMOKE_BASE_URL||'https://findchengyu.com',arg('--expect-hosted')||'on')
        .then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={smoke,probeDescription};

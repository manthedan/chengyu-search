'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {combineLabels,scoreRows}=require('../benchmark/relevance-gate');
const read=name=>fs.readFileSync(path.join(__dirname,'../evaluation/datasets',name));
const sha=x=>createHash('sha256').update(x).digest('hex');
test('frozen relevance data preserves original labels and same-configuration judging provenance',()=>{
    const originalBytes=read('relevance.json'),supplementBytes=read('relevance-supplement.json');
    const original=JSON.parse(originalBytes),supplement=JSON.parse(supplementBytes),baseline=JSON.parse(read('relevance-baseline.json'));
    assert.equal(sha(originalBytes),'2bfe3d67cfafd6e51624c7d92dcf7f979ce83f1cff7dc6495e527913859e37bc');
    assert.equal(sha(originalBytes),baseline.original_sha256);
    assert.equal(sha(originalBytes),supplement.provenance.original_sha256);
    assert.equal(sha(supplementBytes),baseline.supplement_sha256);
    assert.equal(supplement.provenance.judge_model,'deepseek-v4-pro');
    assert.equal(supplement.provenance.thinking,'disabled');
    assert.equal(supplement.provenance.temperature,0);
    assert.equal(supplement.provenance.max_tokens,4096);
    assert.equal(supplement.provenance.prompt_sha256,'2c71c55b4c9b72a70547617131eef06c6a07ec5e47e595e631d45602d783eea1');
    assert.equal(supplement.provenance.dictionary_sha256,'63256ab30e5905ff4ac911881fcf68ce4308d048ff577fb6f1d39f834d9b54a0');
    assert.match(supplement.provenance.date,/^\d{4}-\d{2}-\d{2}$/);
    assert.ok(supplement.labels.length>=895);
    for(const row of supplement.labels){assert.ok(row.reason.trim());assert.match(row.pair_key,/^[a-f0-9]{64}$/);}
    assert.equal(baseline.ref,'970559f908bd1d9a282bcd5bfd39c5198a0dfd89');
    assert.equal(sha(JSON.stringify(baseline.rows)),baseline.rankings_sha256);
    const claudeBytes=read('relevance-supplement-claude.json'),claude=JSON.parse(claudeBytes);
    assert.equal(sha(claudeBytes),baseline.claude_supplement_sha256);
    assert.equal(sha(originalBytes),claude.provenance.original_sha256);
    assert.equal(claude.provenance.judge_model,'claude-opus-5-5');
    for(const row of claude.labels){assert.ok(row.reason.trim());assert.equal(row.grade,Math.min(...row.grades));}
    const computed=scoreRows(baseline.rows,combineLabels(original,supplement,claude));
    assert.equal(computed.overall,baseline.scores.overall);
    assert.equal(computed.primary,baseline.scores.primary);
    assert.equal(computed.coverage.fraction,1);
    assert.equal(computed.summary.total_query_count,82);
    assert.equal(computed.summary.primary_query_count,48);
});

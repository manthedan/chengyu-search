'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {combineLabels,scoreRows,evaluateGate,GAIN_MAPPING,MIN_COVERAGE,FLOAT_TOLERANCE} = require('../benchmark/relevance-gate');
function fixture() {
    const original = [{query:'query',type:'english_meaning',expected:[{chengyu:'old',relevance:3}]}];
    const supplement = {provenance:{gain_mapping:GAIN_MAPPING},labels:[{query_id:'benchmark-0',query:'query',chengyu:'new',grade:2,relevance:3},{query_id:'benchmark-0',query:'query',chengyu:'zero',grade:0,relevance:0}]};
    const rows = [{query:'query',type:'english_meaning',actual_top_results:['old','zero']}];
    const scores = scoreRows(rows,combineLabels(original,supplement));
    const baseline = {ref:'970559f',rows,policy:{min_top5_coverage:MIN_COVERAGE,float_tolerance:FLOAT_TOLERANCE},scores:{overall:scores.overall,primary:scores.primary}};
    return {original,supplement,baseline,rows};
}
test('supplement expands labels including explicit zero without mutating original qrels', () => {
    const f=fixture(),before=JSON.stringify(f.original);
    assert.equal(combineLabels(f.original,f.supplement)[0].expected.length,3);
    assert.equal(JSON.stringify(f.original),before);
    assert.equal(evaluateGate(f).combined.coverage.fraction,1);
    assert.ok(evaluateGate(f).passed);
});
test('combined labels reward newly judged relevant results and retain original-only reference', () => {
    const f=fixture();f.rows=[{...f.rows[0],actual_top_results:['new','old']}];
    const gate=evaluateGate(f);
    assert.ok(gate.passed);
    assert.equal(gate.combined.overall,1);
    assert.ok(gate.original_only.overall<gate.combined.overall);
});
test('any unknown returned top-five slot fails with needs judging and a key-requiring command', () => {
    const f=fixture();f.rows=[{...f.rows[0],actual_top_results:['old','unknown']}];
    const gate=evaluateGate(f);
    assert.equal(gate.passed,false);
    assert.equal(gate.combined.coverage.fraction,.5);
    assert.match(gate.failures.join(),/needs judging.*DeepSeek key.*judge.js/);
    assert.deepEqual(gate.combined.coverage.missing,[{query:'query',chengyu:'unknown'}]);
});
test('unjudged baseline slots also fail, and ranks beyond five do not affect coverage', () => {
    const f=fixture();f.rows[0].actual_top_results=['old','zero','zero','zero','zero','unknown'];
    assert.equal(evaluateGate(f).combined.coverage.fraction,1);
    f.baseline.rows=[{...f.rows[0],actual_top_results:['old','unknown']}];
    assert.match(evaluateGate(f).failures.join(),/needs judging: baseline/);
});
test('a fully labeled ranking regression fails even when the former fixed threshold would pass', () => {
    const f=fixture();f.rows=[{...f.rows[0],actual_top_results:['zero','old']}];
    const gate=evaluateGate(f);
    assert.ok(gate.combined.overall>.30);
    assert.equal(gate.passed,false);
    assert.match(gate.failures.join(),/below live 970559f/);
});
test('only floating-point noise is tolerated and baseline values must be reproducible', () => {
    const f=fixture();f.baseline.scores.overall+=FLOAT_TOLERANCE/2;
    assert.ok(evaluateGate(f).passed);
    f.baseline.scores.overall+=.000001;
    assert.throws(()=>evaluateGate(f),/Baseline derivation mismatch/);
    const g=fixture();g.baseline.policy.min_top5_coverage=.99;
    assert.throws(()=>evaluateGate(g),/policy drift/);
});
test('rejects regrading originals, duplicate additions, changed scale and mismatched query identities', () => {
    let f=fixture();f.supplement.labels[0].chengyu='old';assert.throws(()=>combineLabels(f.original,f.supplement),/overwrite/);
    f=fixture();f.supplement.labels.push(f.supplement.labels[0]);assert.throws(()=>combineLabels(f.original,f.supplement),/Duplicate/);
    f=fixture();f.supplement.labels[0].relevance=2;assert.throws(()=>combineLabels(f.original,f.supplement),/grade/);
    f=fixture();f.supplement.labels[0].query='changed';assert.throws(()=>combineLabels(f.original,f.supplement),/identity/);
    f=fixture();f.supplement.provenance.gain_mapping={0:0,1:1,2:2};assert.throws(()=>combineLabels(f.original,f.supplement),/mapping/);
});
test('missing or duplicate query results cannot improve the gate by changing the denominator', () => {
    const f=fixture();assert.throws(()=>evaluateGate({...f,rows:[]}),/Missing retrieval/);
    assert.throws(()=>evaluateGate({...f,rows:[...f.rows,...f.rows]}),/duplicate/);
    assert.equal(evaluateGate({...f,errors:[{query:'query'}]}).passed,false);
});
test('the ranking comparison tolerates only sub-1e-12 floating-point differences', () => {
    for (const [gain, shouldPass] of [[1e-12,true],[1e-9,false]]) {
        const f=fixture();f.original[0].expected.push({chengyu:'epsilon',relevance:gain});
        f.baseline.rows=[{...f.rows[0],actual_top_results:['old','epsilon']}];
        const score=scoreRows(f.baseline.rows,combineLabels(f.original,f.supplement));
        f.baseline.scores={overall:score.overall,primary:score.primary};
        assert.equal(evaluateGate(f).passed,shouldPass);
    }
});

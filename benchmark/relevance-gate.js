'use strict';
const {ndcg, summarizeScores} = require('./scoring');

// All returned top-five slots must have an explicit label, including grade zero.
const MIN_COVERAGE = 1;
// Scores are compared before rounding. This only absorbs floating-point noise.
const FLOAT_TOLERANCE = 1e-12;
const GAIN_MAPPING = Object.freeze({0:0, 1:1.5, 2:3});
const JUDGING_COMMAND = 'node experiments/corpus-v2/fix-round-2/judge.js --run --wait-offpeak --refresh-pool && node experiments/corpus-v2/fix-round-2/build-labels.js';

// Supplements are applied in order (the DeepSeek supplement, then the blind
// Claude supplement for pairs it never saw); none may relabel an existing pair.
function combineLabels(original, supplement, ...moreSupplements) {
    const supplements = [supplement, ...moreSupplements.filter(Boolean)];
    for (const s of supplements) {
        if (JSON.stringify(s.provenance.gain_mapping) !== JSON.stringify(GAIN_MAPPING)) {
            throw Error('Unexpected supplement gain mapping; expected predeclared 0/1.5/3');
        }
    }
    const combined = original.map(q => ({...q, expected:q.expected.map(e => ({...e}))}));
    const seen = combined.map(q => new Set(q.expected.map(e => e.chengyu)));
    for (const label of supplements.flatMap(s => s.labels)) {
        const match = /^benchmark-(0|[1-9][0-9]*)$/.exec(label.query_id);
        const index = match ? Number(match[1]) : -1;
        const query = combined[index];
        if (!query || !original[index].expected.length || query.query !== label.query) throw Error('Supplement query identity mismatch');
        if (typeof label.chengyu !== 'string' || !label.chengyu || !Number.isInteger(label.grade) || !Object.hasOwn(GAIN_MAPPING, label.grade) || GAIN_MAPPING[label.grade] !== label.relevance) throw Error('Invalid supplemental grade');
        if (seen[index].has(label.chengyu)) throw Error('Duplicate supplemental label or attempt to overwrite an original label');
        seen[index].add(label.chengyu);
        query.expected.push({chengyu:label.chengyu, relevance:label.relevance});
    }
    return combined;
}

function scoreRows(rows, testSet) {
    const queries = new Map(testSet.filter(q=>q.expected.length).map(q=>[q.query,q]));
    const seen = new Set(), missing = [], scored = [];
    let slots = 0, labeled = 0;
    for (const row of rows) {
        const q = queries.get(row.query);
        if (!q || seen.has(row.query) || row.type !== q.type || !Array.isArray(row.actual_top_results)) throw Error('Unexpected, duplicate or malformed retrieval query');
        seen.add(row.query);
        const known = new Set(q.expected.map(e=>e.chengyu));
        const heads = row.actual_top_results.slice(0,5);
        for (const chengyu of heads) {
            slots++;
            if (known.has(chengyu)) labeled++;
            else missing.push({query:q.query, chengyu});
        }
        scored.push({query:q.query, type:q.type, ndcg:ndcg(heads.map(chengyu=>({chengyu})),q.expected,5)});
    }
    if (seen.size !== queries.size) throw Error(`Missing retrieval queries: expected ${queries.size}, received ${seen.size}`);
    const overall = scored.reduce((s,r)=>s+r.ndcg,0)/scored.length;
    const primaryRows = scored.filter(r=>['english_meaning','thematic'].includes(r.type));
    const primary = primaryRows.length ? primaryRows.reduce((s,r)=>s+r.ndcg,0)/primaryRows.length : 0;
    return {overall, primary, summary:summarizeScores(scored), coverage:{labeled,slots,fraction:slots ? labeled/slots : 1,missing}, per_query:scored};
}

function evaluateGate({original, supplement, claudeSupplement = null, baseline, rows, errors=[]}) {
    const combined = combineLabels(original, supplement, claudeSupplement);
    const reference = scoreRows(rows, original);
    const live = scoreRows(baseline.rows, combined);
    const candidate = scoreRows(rows, combined);
    if (baseline.policy.min_top5_coverage !== MIN_COVERAGE || baseline.policy.float_tolerance !== FLOAT_TOLERANCE) throw Error('Release gate policy drift');
    for (const metric of ['overall','primary']) {
        if (!Number.isFinite(baseline.scores[metric]) || Math.abs(live[metric]-baseline.scores[metric])>FLOAT_TOLERANCE) throw Error('Baseline derivation mismatch; regenerate against the same combined labels');
    }
    const failures = [];
    if (errors.length) failures.push(`${errors.length} retrieval request errors`);
    for (const [name, score] of [['baseline',live],['candidate',candidate]]) {
        if (score.coverage.fraction < MIN_COVERAGE) failures.push(`needs judging: ${name} top-5 label coverage ${score.coverage.labeled}/${score.coverage.slots} < 100%. Run in the private maintainer repository (requires runtime DeepSeek key): ${JUDGING_COMMAND}`);
    }
    if (!failures.length) {
        for (const metric of ['overall','primary']) if(candidate[metric]+FLOAT_TOLERANCE<live[metric]) failures.push(`${metric} NDCG@5 ${candidate[metric]} is below live 970559f ${live[metric]} (tolerance ${FLOAT_TOLERANCE})`);
    }
    return {passed:failures.length===0, failures, original_only:reference, combined:candidate, live_combined:live, baseline_ref:baseline.ref, tolerance:FLOAT_TOLERANCE};
}

module.exports = {combineLabels,scoreRows,evaluateGate,MIN_COVERAGE,FLOAT_TOLERANCE,GAIN_MAPPING,JUDGING_COMMAND};

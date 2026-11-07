const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mergeAndRank}=require('../src/search/search-logic');
const candidate=(id,field,value)=>({id,chengyu:id,[field]:value,item:{id,chengyu:id}});
const config={semanticWeight:.85,keywordWeight:.15,overlapBonus:.16};
const score=(keywords,semantics,c=config)=>mergeAndRank(keywords,semantics,[],c)[0].score;
test('hybrid evidence uses one scale when corpus growth removes a channel candidate',()=>{
 const k=candidate('one','keyword_score',.9),s=candidate('one','semantic_score',.6);
 const keywordOnly=score([k],[]),semanticOnly=score([],[s]),both=score([k],[s]);
 assert.ok(both>=keywordOnly);assert.ok(both>=semanticOnly);
 assert.ok(Math.abs(keywordOnly-.135)<1e-12);assert.ok(Math.abs(semanticOnly-.51)<1e-12);
 // Competitors may evict this entry from either candidate window. Neither
 // eviction should improve its score relative to an unaffected competitor.
 const competitor=candidate('two','semantic_score',.8);
 assert.equal(mergeAndRank([k],[competitor],[],config)[0].id,'two');
 assert.equal(mergeAndRank([k],[s,competitor],[],config)[0].id,'one');
});
test('zero channel weights remain zero and exact pinyin keeps its priority',()=>{
 const k=candidate('one','keyword_score',.9),s=candidate('one','semantic_score',.6);
 assert.equal(score([k],[],{semanticWeight:1,keywordWeight:0}),0);
 assert.equal(score([],[s],{semanticWeight:0,keywordWeight:1}),0);
 const rows=mergeAndRank([k],[s],[candidate('exact','pinyin_exact_score',1)],config);
 assert.equal(rows[0].id,'exact');assert.equal(rows[0].score,11);
});
test('Chinese hybrid lookups keep lexical ordering and scores',async()=>{
 const {search,keywordSearchOnly}=require('../src/search/search-logic');
 const cfg=require('../src/search/search-config');
 const data=[{id:'a',chengyu:'好山好水',meaning:'beautiful scenery',pinyin:'hao3 shan1 hao3 shui3'},{id:'b',chengyu:'山高水长',meaning:'lasting influence',pinyin:'shan1 gao1 shui3 chang2'}];
 const actual=await search('山',data,null,cfg);
 const expected=keywordSearchOnly('山',data,cfg);
 assert.deepEqual(actual,expected);
});

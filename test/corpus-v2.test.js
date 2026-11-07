'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const corpus=require('../chengyuData');
const {buildStableChengyuId}=require('../src/data/chengyu-identity');
const {buildResultPayload}=require('../src/server/search-response');
test('v2 serving corpus has complete frontend records, distinct sense IDs and no private provenance',()=>{
 assert.equal(corpus.length,7348);const ids=new Set();
 const allowed=new Set(['id','chengyu','pinyin','literal','meaning','example','tags','formality','meaning_zh','kind','simplified','traditional']);
 for(const r of corpus){
  for(const field of ['chengyu','pinyin','literal','meaning','example','formality','traditional'])assert.ok(typeof r[field]==='string'&&r[field].trim(),`${r.chengyu}: ${field}`);
  assert.equal(r.simplified,r.chengyu);assert.equal(r.id,buildStableChengyuId(r));assert.ok(!ids.has(r.id));ids.add(r.id);
  assert.ok(Object.keys(r).every(k=>allowed.has(k)));assert.ok(['chengyu','set_phrase','official_political','technical_or_proper'].includes(r.kind));
  assert.ok(r.tags.length);assert.ok(r.example.includes(r.chengyu));
 }
 // Ranking v1 reclassifies only the legacy population. Preserve the audited
 // backfill kinds independently of later legacy decisions.
 assert.equal(corpus.slice(5925).filter(r=>r.kind==='set_phrase').length,140);
 assert.equal(corpus.filter(r=>!r.meaning_zh).length,32);
 assert.ok(corpus.every(r=>r.formality==='formal'));
 assert.equal(corpus.filter(r=>r.chengyu==='难兄难弟').length,2);
});
test('new backfill records carry traditional script, bilingual content and API additions',()=>{
 const record=corpus[5925];assert.ok(record.meaning_zh);assert.ok(record.example.includes('('));
 const payload=buildResultPayload([{item:record,chengyu:record.chengyu,score:.9}])[0];
 for(const f of ['id','traditional','pinyin','meaning','example','meaning_zh','kind'])assert.equal(payload[f],record[f]);
 const annotations=require('../public/generated/example-annotations.json'),dict=require('../public/generated/dictionary-subset.json');
 const ids=new Set(dict.map(r=>r.id));assert.equal(Object.keys(annotations).length,corpus.length);
 for(const [i,r]of corpus.entries()){
  const a=annotations[String(i)];assert.equal(a.chengyu,r.chengyu);assert.ok(r.example.includes(a.text));
  for(const token of [...a.tokens,...a.headwordTokens])for(const id of token.entryIds)assert.ok(ids.has(id),`${r.chengyu}: ${id}`);
 }
});

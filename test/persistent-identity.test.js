const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildStableChengyuId,withStableChengyuIds}=require('../src/data/chengyu-identity');
const corpus=require('../chengyuData');
test('all persisted serving IDs survive arbitrary repairs to text and formality',()=>{
 for(const record of corpus){
  assert.equal(buildStableChengyuId({...record,meaning:'repaired',literal:'updated',example:'new example',tags:['changed'],formality:'neutral'}),record.id);
 }
 const fresh={chengyu:'甲乙丙丁',pinyin:'jia3 yi3 bing3 ding1',meaning:'before'};
 assert.equal(buildStableChengyuId(fresh),buildStableChengyuId({...fresh,meaning:'after',literal:'changed',tags:['new']}));
});
test('same-headword/same-pinyin senses keep explicit IDs; unassigned collisions fail closed',()=>{
 const pair=corpus.filter(r=>r.chengyu==='一目了然');assert.equal(pair.length,2);assert.equal(pair[0].pinyin,pair[1].pinyin);
 assert.equal(new Set(withStableChengyuIds(pair).map(r=>r.id)).size,2);
 assert.throws(()=>withStableChengyuIds(pair.map(({id,...r})=>r)),/distinct persistent sense IDs/);
});

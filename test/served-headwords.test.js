const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const corpus=require('../chengyuData'),config=require('../src/search/search-config');
const {search,keywordSearchOnly,getQueryVariants}=require('../src/search/search-logic');
const {normalizeChineseQuery}=require('../src/data/chinese-query');
test('every served simplified and displayed traditional headword returns its exact sense ID',async()=>{
 for(const record of corpus)for(const query of [record.simplified,record.traditional]){
  for(const results of [keywordSearchOnly(query,corpus,config),await search(query,corpus,null,config)]){
   assert.ok(results.some(r=>r.id===record.id),`${query} must resolve ${record.chengyu} / ${record.id}`);
   assert.equal(results[0].chengyu,record.chengyu,`exact headword must rank first: ${query}`);
  }
 }
});
test('serving uses the reviewed compact package and preserves sentence-level normalization',()=>{
 const manifest=require('../src/data/chinese-normalizer/normalizer-data.manifest.json');
 const bytes=fs.readFileSync(path.join(__dirname,'../src/data/chinese-normalizer/normalizer-data.bin'));
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.artifact_sha256);
 for(const [query,expected]of [['我們討論著火的原因','我们讨论着火的原因'],['大家談論著該怎麼辦','大家谈论着该怎么办'],['軒然大波','轩然大波'],['婆婆媽媽','婆婆妈妈'],['臥薪嚐膽','卧薪尝胆']]){
  assert.equal(normalizeChineseQuery(query,corpus),expected);
  assert.equal(getQueryVariants(query,corpus).lexicalQuery,expected);
 }
});
test('an ambiguous displayed form preserves every distinct sense/headword',()=>{
 const database=[{id:'first',chengyu:'甲',traditional:'別',pinyin:'jia3'},{id:'second',chengyu:'乙',traditional:'別',pinyin:'yi3'}];
 assert.deepEqual(keywordSearchOnly('別',database,config).map(r=>r.id),['first','second']);
});

'use strict';
// Exact displayed forms belong to the serving corpus; general script folding
// belongs to the compact, build-time compiled Chinese normalizer.
const {normalize}=require('./chinese-normalizer/normalize');
const indexes=new WeakMap();
function headwordIndex(database){
 if(indexes.has(database))return indexes.get(database);
 const index=new Map();
 for(const entry of database)for(const form of new Set([entry.chengyu,entry.simplified,entry.traditional].filter(Boolean))){
  if(!index.has(form))index.set(form,[]);
  index.get(form).push(entry);
 }
 indexes.set(database,index);return index;
}
function exactHeadwordMatches(query,database){return headwordIndex(database).get(String(query).trim())||[];}
function normalizeChineseQuery(query,database=[]){
 const text=String(query),trimmed=text.trim(),matches=exactHeadwordMatches(trimmed,database);
 // Do not resolve an ambiguous spelling to just one sense/headword.
 if(matches.length){const heads=new Set(matches.map(r=>r.chengyu));return heads.size===1?text.replace(trimmed,matches[0].chengyu):text;}
 return normalize(text);
}
module.exports={normalizeChineseQuery,exactHeadwordMatches};

'use strict';
// Only normalize.js, compact-table.js and normalizer-data.bin are serving files.
// No source dictionaries load until build/test; the binary loads on first Han.
let table;
const getTable = () => table ||= require('./compact-table').load();
const hasHan = text => /\p{Script=Han}/u.test(text);
const preprocess = text => String(text).replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/gu, c => c.normalize('NFKC')).trim();
// Synchronous calls reuse numeric scratch space rather than allocating per-word
// objects/Maps on every query. It is never exposed or retained with query text.
let capacity=0, costs, ends, protectedStart, protectedEnd, offsets;
function workspace(length) {
    if(length+1<=capacity)return;
    capacity=2**Math.ceil(Math.log2(length+1));
    costs=new Uint32Array(capacity);ends=new Uint32Array(capacity);
    protectedStart=new Uint32Array(capacity);protectedEnd=new Uint32Array(capacity);offsets=new Uint32Array(capacity);
}
function foldCP(cp) {
    const d=getTable(),i=d.charIndex(cp);
    return i<0||!d.exclusive[i]?cp:d.exclusive[i];
}
function fold(text) {
    let result='',copied=0;
    for(let i=0;i<text.length;) {
        const cp=text.codePointAt(i),target=foldCP(cp),width=cp>65535?2:1;
        if(target!==cp){result+=text.slice(copied,i)+String.fromCodePoint(target);copied=i+width;}
        i+=width;
    }
    return result+text.slice(copied);
}
function segment(text) {
    // Same minimum-token DP/ties as round 4. UTF-16 indices remain exact even
    // when a supplement character changes width or an input has lone surrogates.
    const d=getTable();workspace(text.length);costs[text.length]=0;
    for(let i=text.length-1;i>=0;i--) {
        const cp=text.charCodeAt(i);
        if(cp>=0xdc00 && cp<=0xdfff && i>0 && text.charCodeAt(i-1)>=0xd800 && text.charCodeAt(i-1)<=0xdbff)i--;
        let end=i+(text.codePointAt(i)>65535?2:1),best=1+costs[end],node=d.root;
        for(let j=i;j<text.length;) {
            const c=text.codePointAt(j);node=d.next(node,c);if(node<0)break;j+=c>65535?2:1;
            if(d.flags[node]&d.BOUNDARY) {
                const cost=1+costs[j];
                if(cost<best || cost===best && j>end){best=cost;end=j;}
            }
        }
        costs[i]=best;ends[i]=end;
    }
}
function pass(text) {
    const d=getTable(),originalFolded=fold(text);
    workspace(Math.max(text.length,originalFolded.length));segment(originalFolded);
    protectedStart.fill(0,0,originalFolded.length);
    for(let start=0;start<originalFolded.length;) {
        const end=ends[start],matchedEnd=d.lookup(originalFolded,start,false,end);
        if(end-start>(originalFolded.codePointAt(start)>65535?2:1) && matchedEnd===end && d.lastId===1) {
            protectedStart.fill(start+1,start,end);protectedEnd.fill(end,start,end);
        }
        start=end;
    }
    let foldedOffset=0;
    for(let i=0;i<text.length;) {
        const cp=text.codePointAt(i);offsets[i]=foldedOffset;
        foldedOffset+=foldCP(cp)>65535?2:1;i+=cp>65535?2:1;
    }
    offsets[text.length]=foldedOffset;
    // Original-spelling OpenCC conversions cannot alter characters protected by
    // a different selected identity word (高明+瞭 versus 找見+覆滅).
    let scripted='',copied=0;
    for(let i=0;i<text.length;) {
        const matchedEnd=d.lookup(text,i,true),id=d.lastId;
        if(matchedEnd>=0) {
            const value=d.value(id,text,i,matchedEnd),aa=[...text.slice(i,matchedEnd)],bb=[...value];
            const start=offsets[i],end=offsets[matchedEnd];let pos=start,blocked=false;
            for(let j=0;j<aa.length;j++) {
                const cp=foldCP(aa[j].codePointAt(0));
                if(cp!==foldCP(bb[j]?.codePointAt(0)) && protectedStart[pos] &&
                    (protectedStart[pos]-1!==start || protectedEnd[pos]!==end))blocked=true;
                pos+=cp>65535?2:1;
            }
            if(!blocked){if(id!==1){scripted+=text.slice(copied,i)+value;copied=matchedEnd;}i=matchedEnd;continue;}
        }
        i+=text.codePointAt(i)>65535?2:1;
    }
    const folded=fold(scripted+text.slice(copied)),cp=folded.codePointAt(0),singleIndex=cp===undefined?-1:d.charIndex(cp);
    if(singleIndex>=0 && folded.length===(cp>65535?2:1) && (d.shared[singleIndex]&d.BOUNDARY))return folded;
    segment(folded);let result='';copied=0;
    for(let start=0;start<folded.length;) {
        const end=ends[start];
        for(let i=start;i<end;) {
            const matchedEnd=d.lookup(folded,i,false,end),id=d.lastId;
            if(matchedEnd>=0){
                if(id!==1){result+=folded.slice(copied,i)+d.value(id,folded,i,matchedEnd);copied=matchedEnd;}
                i=matchedEnd;
            }
            else {
                const cp=folded.codePointAt(i),k=d.charIndex(cp),target=k<0?0:d.shared[k]&d.MASK;
                const width=cp>65535?2:1;
                if(target && target!==cp){result+=folded.slice(copied,i)+String.fromCodePoint(target);copied=i+width;}
                i+=width;
            }
        }
        start=end;
    }
    return result+folded.slice(copied);
}
function normalize(text) {
    let value=preprocess(text);
    if(!hasHan(value))return value;
    const seen=new Set();
    while(!seen.has(value)) {
        seen.add(value);const next=pass(value);
        if(next===value)return value;value=next;
    }
    throw new Error('Cyclic normalization dictionary');
}
module.exports={normalize,hasHan,preprocess};

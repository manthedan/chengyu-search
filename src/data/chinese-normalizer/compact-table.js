'use strict';
// The serving loader reads only the compiled binary. All views share its buffer.
const BOUNDARY=0x80000000, MASK=0x7fffffff;
function load() {
    const b=require('node:fs').readFileSync(require('node:path').join(__dirname,'normalizer-data.bin'));
    if(require('node:os').endianness()!=='LE')throw new Error('Normalizer requires little-endian Node');
    if(b.toString('ascii',0,8)!=='ZHNORM01'||b.readUInt32LE(8)!==1||b.readUInt32LE(36)!==b.length)throw new Error('Invalid normalizer artifact');
    const root=b.readUInt32LE(12),n=b.readUInt32LE(16),e=b.readUInt32LE(20),c=b.readUInt32LE(24),v=b.readUInt32LE(28),bytes=b.readUInt32LE(32);
    let pos=64;
    const array=count=>{const a=new Uint32Array(b.buffer,b.byteOffset+pos,count);pos+=count*4;return a;};
    const first=array(n+1),flags=array(n),raw=array(n),edgeCP=array(e),edgeNext=array(e),charCP=array(c),exclusive=array(c),shared=array(c),offsets=array(v+1);
    if(root>=n||first[n]!==e||offsets[v]!==bytes||pos+bytes!==b.length)throw new Error('Invalid normalizer table sizes');
    const strings=b.subarray(pos), cache=[];
    // Constant-size BMP index; supplementary characters use sorted lookup.
    const bmp=new Uint32Array(65536);
    charCP.forEach((cp,i)=>{if(cp<65536)bmp[cp]=i+1;});
    function charIndex(cp) {
        if(cp<65536)return bmp[cp]-1;
        let lo=0,hi=charCP.length-1;
        while(lo<=hi){const m=(lo+hi)>>>1,x=charCP[m];if(x===cp)return m;if(x<cp)lo=m+1;else hi=m-1;}
        return -1;
    }
    function next(node,cp) {
        let lo=first[node],hi=first[node+1]-1;
        while(lo<=hi){const m=(lo+hi)>>>1,x=edgeCP[m];if(x===cp)return edgeNext[m];if(x<cp)lo=m+1;else hi=m-1;}
        return -1;
    }
    const table={root,next,flags,charIndex,exclusive,shared,BOUNDARY,MASK,lastId:0};
    function lookup(text,start,original=false,limit=text.length) {
        let node=root,end=-1,id=0;
        for(let j=start;j<limit;){
            const cp=text.codePointAt(j);node=next(node,cp);if(node<0)break;j+=cp>65535?2:1;
            const value=original?raw[node]:flags[node]&MASK;
            if(value){end=j;id=value;}
        }
        table.lastId=id;return end;
    }
    table.lookup=lookup;
    table.value=(id,text,start,end)=>id===1?text.slice(start,end):(cache[id]??=strings.toString('utf8',offsets[id-2],offsets[id-1]));
    return table;
}
module.exports={load};

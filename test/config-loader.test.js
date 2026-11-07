'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const loader = require('../src/search/config-loader');

test('unchanged configs reuse exports; changed files, overrides and failures reload correctly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-reload-'));
    const base = path.join(dir, 'base.js'), hybrid = path.join(dir, 'hybrid.json');
    const dependency = path.join(dir, 'dependency.js');
    const env = {...process.env};
    try {
        delete process.env.SEARCH_CONFIG_OVERRIDE_JSON;
        delete process.env.SEARCH_CONFIG_OVERRIDE_FILE;
        fs.writeFileSync(dependency, 'module.exports={}');
        fs.writeFileSync(base, "require('./dependency');module.exports={version:1,nested:{a:1,b:2}}");
        fs.writeFileSync(hybrid, '{"version":1}');
        const first = loader.loadFreshSearchConfig({configPath:base});
        const firstHybrid = loader.loadHybridOverrides({hybridConfigPath:hybrid});
        for (let i=0; i<1000; i++) {
            assert.equal(loader.loadFreshSearchConfig({configPath:base}), first);
            assert.equal(loader.loadHybridOverrides({hybridConfigPath:hybrid}), firstHybrid);
        }
        const times = fs.statSync(base);
        fs.writeFileSync(base, 'module.exports={version:2,nested:{a:1,b:2}}');
        fs.utimesSync(base, times.atime, times.mtime);
        fs.writeFileSync(hybrid, '{"version":2}');
        assert.equal(loader.loadFreshSearchConfig({configPath:base}).version, 2);
        assert.equal(require.cache[dependency].parent, null, 'dependency must release superseded config module');
        assert.equal(loader.loadHybridOverrides({hybridConfigPath:hybrid}).version, 2);
        process.env.SEARCH_CONFIG_OVERRIDE_JSON = '{"nested":{"a":3}}';
        assert.deepEqual(loader.loadFreshSearchConfig({configPath:base}).nested, {a:3,b:2});
        assert.equal(loader.loadSearchConfigOverride(), loader.loadSearchConfigOverride());
        delete process.env.SEARCH_CONFIG_OVERRIDE_JSON;
        process.env.SEARCH_CONFIG_OVERRIDE_FILE = hybrid;
        assert.equal(loader.loadFreshSearchConfig({configPath:base}).version, 2);
        fs.writeFileSync(hybrid, '{"version":3}');
        assert.equal(loader.loadFreshSearchConfig({configPath:base}).version, 3);
        delete process.env.SEARCH_CONFIG_OVERRIDE_FILE;
        delete require.cache[dependency];
        fs.writeFileSync(base, "require('./dependency');throw Error('broken config')");
        assert.deepEqual(loader.loadFreshSearchConfig({configPath:base, fallbackConfig:{fallback:true}}), {fallback:true});
        assert.equal(require.cache[dependency].parent, null, 'failed modules must also release dependency parent links');
        fs.writeFileSync(base, 'module.exports={version:4}');
        assert.equal(loader.loadFreshSearchConfig({configPath:base}).version, 4);
    } finally {
        process.env = env;
        fs.rmSync(dir, {recursive:true,force:true});
    }
});

test('repeated reloads and simulated ranked-cache misses bound retained modules and live heap', t => {
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', `
        const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
        const loader=require(${JSON.stringify(require.resolve('../src/search/config-loader'))});
        delete process.env.SEARCH_CONFIG_OVERRIDE_JSON;delete process.env.SEARCH_CONFIG_OVERRIDE_FILE;
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'config-heap-'));
        const base=path.join(dir,'base.js'),hybrid=path.join(dir,'hybrid.json');
        const update=i=>{
            fs.writeFileSync(base,'module.exports={version:'+i+',payload:Array(8192).fill('+i+')}');
            fs.writeFileSync(hybrid,JSON.stringify({version:i,payload:Array(8192).fill(i)}));
            const override=path.join(dir,'override-'+i+'.json');
            fs.writeFileSync(override,JSON.stringify({version:i}));
            process.env.SEARCH_CONFIG_OVERRIDE_FILE=override;
            // Each iteration simulates ten misses loading both serving configs.
            for(let miss=0;miss<10;miss++){
                assert.equal(loader.loadFreshSearchConfig({configPath:base}).version,i);
                assert.equal(loader.loadHybridOverrides({hybridConfigPath:hybrid}).version,i);
            }
        };
        try {
            for(let i=0;i<50;i++)update(i);
            global.gc();const before=process.memoryUsage().heapUsed;
            for(let i=50;i<850;i++)update(i);
            global.gc();const growth=process.memoryUsage().heapUsed-before;
            const cached=Object.values(require.cache).filter(m=>m.filename.startsWith(dir));
            const retained=Object.values(require.cache).flatMap(m=>m.children).filter(m=>m.filename.startsWith(dir));
            assert.equal(cached.length,3,'only the current base, hybrid and override modules are cached');
            assert.equal(retained.length,0,'config modules must not accumulate in parent children');
            assert.ok(growth<6*1024*1024,'live heap grew '+growth+' bytes over 800 changed reloads / 8000 cache misses');
            console.log(JSON.stringify({changed_reloads:800,cache_misses:8000,cached:cached.length,retained:retained.length,heap_growth_bytes:growth}));
        } finally {fs.rmSync(dir,{recursive:true,force:true});}
    `], {encoding:'utf8',timeout:60000,env:{...process.env,NODE_OPTIONS:''}});
    assert.equal(child.status, 0, child.stderr || child.stdout);
    t.diagnostic(child.stdout.trim());
});

'use strict';
process.env.QUIET_LOGS = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    createVariantFamilies, rankCollapsed, isVariantGroupingEnabled, loadVariantFamilies
} = require('../src/search/variant-grouping');
const { createSearchExecutionService, normalizePagination } = require('../src/search/search-service');
const { createPaginatedSearchResponse } = require('../src/server/search-response');
const { withHostedSearch } = require('../src/search/hosted-search');
const { writeQwenIndex, readQwenIndex } = require('../src/embeddings/qwen-index');
const { loadChengyuCorpus } = require('../src/data/corpus-loader');
const { TTLCache } = require('../src/shared/cache');

const FIXTURE = path.join(__dirname, 'fixtures', 'variant-families.json');
const entry = (id, simplified, extra = {}) => ({ id, publicId: id, chengyu: simplified, simplified, traditional: `${simplified}T`, pinyin: `py-${id}`, ...extra });
const link = (a, b, relation = 'same', common = 'a') => ({ a, b, relation, common });
const DB = [
    entry('blind', '盲人摸象'), entry('xiazi', '瞎子摸象'), entry('zhong', '众盲摸象'),
    entry('sai', '塞翁失马'), entry('yan', '塞翁失马焉知非福'), entry('an', '塞翁失马安知非福'),
    entry('hua', '百花齐放'), entry('jia', '百家争鸣'), entry('couplet', '百花齐放，百家争鸣'),
    entry('x1', '甲'), entry('x2', '乙'), entry('x3', '丙'), entry('x4', '丁'), entry('x5', '戊'), entry('x6', '己'),
    entry('sense1', '双义'), entry('sense2', '双义', { pinyin: 'other' }), entry('pair', '双义变体')
];
const MAP = { version: 'unit', links: [
    link('盲人摸象', '瞎子摸象'), link('瞎子摸象', '众盲摸象'),
    link('塞翁失马', '塞翁失马焉知非福', 'full_form'), link('塞翁失马焉知非福', '塞翁失马安知非福'),
    link('百花齐放', '百花齐放，百家争鸣', 'full_form', 'equal'), link('百家争鸣', '百花齐放，百家争鸣', 'full_form', 'b'),
    link('双义', '双义变体')
] };
const families = createVariantFamilies(MAP, DB);
const ids = list => list.map(r => r.id);
const byId = new Map(DB.map(e => [e.id, e]));
const ranked = idList => idList.map((id, i) => ({ id, chengyu: byId.get(id).chengyu, item: byId.get(id), score: 1 - i / 100 }));

test('loader validation rejects malformed maps and unknown headwords', () => {
    const bad = [
        [null, /object/], [{ links: [] }, /version/], [{ version: 'v' }, /links/],
        [{ version: 'v', links: [link('盲人摸象', '盲人摸象')] }, /itself/],
        [{ version: 'v', links: [link('盲人摸象', '瞎子摸象', 'variant')] }, /relation/],
        [{ version: 'v', links: [link('盲人摸象', '瞎子摸象', 'same', 'both')] }, /common/],
        [{ version: 'v', links: [link('盲人摸象', '不存在的词')] }, /not a corpus headword/],
        [{ version: 'v', links: [link('盲人摸象', '瞎子摸象'), link('瞎子摸象', '盲人摸象')] }, /repeats/]
    ];
    for (const [map, pattern] of bad) assert.throws(() => createVariantFamilies(map, DB), pattern);
    assert.equal(createVariantFamilies({ version: 'v', links: [] }, DB).collapse(ranked(['blind', 'xiazi'])).length, 2);
});

test('same links are transitive (union-find); full_form links one cluster to another and never chain', () => {
    assert.ok(families.areRelated('盲人摸象', '众盲摸象'), 'transitive through 瞎子摸象');
    assert.ok(families.areRelated('众盲摸象', '盲人摸象'));
    assert.ok(families.areRelated('塞翁失马', '塞翁失马焉知非福'));
    assert.ok(families.areRelated('塞翁失马', '塞翁失马安知非福'), 'full_form reaches the whole same-cluster');
    assert.ok(families.areRelated('百花齐放', '百花齐放，百家争鸣'));
    assert.ok(families.areRelated('百家争鸣', '百花齐放，百家争鸣'));
    assert.ok(!families.areRelated('百花齐放', '百家争鸣'), 'two halves of one couplet are not variants of each other');
    assert.ok(!families.areRelated('盲人摸象', '盲人摸象'));
    assert.ok(!families.areRelated('盲人摸象', '塞翁失马'));
});

test('variantsOf lists every related form from the map with its relation, excluding the entry itself', () => {
    assert.deepEqual(families.variantsOf(byId.get('xiazi')).map(v => [v.simplified, v.relation]),
        [['盲人摸象', 'same'], ['众盲摸象', 'same']]);
    assert.deepEqual(families.variantsOf(byId.get('sai')).map(v => [v.simplified, v.relation]),
        [['塞翁失马焉知非福', 'full_form'], ['塞翁失马安知非福', 'full_form']]);
    assert.deepEqual(families.variantsOf(byId.get('yan')).map(v => [v.simplified, v.relation]),
        [['塞翁失马安知非福', 'same'], ['塞翁失马', 'full_form']]);
    assert.deepEqual(families.variantsOf(byId.get('couplet')).map(v => v.simplified), ['百花齐放', '百家争鸣']);
    assert.deepEqual(families.variantsOf(byId.get('hua')).map(v => v.simplified), ['百花齐放，百家争鸣']);
    assert.deepEqual(families.variantsOf(byId.get('blind'))[0],
        { simplified: '瞎子摸象', traditional: '瞎子摸象T', pinyin: 'py-xiazi', publicId: 'xiazi', relation: 'same', preferred: false, common: false });
    // The family's usual form is marked for the page to name it.
    assert.deepEqual(families.variantsOf(byId.get('xiazi')).filter(v => v.preferred).map(v => v.simplified), ['盲人摸象']);
    // So is each linked cluster's usual spelling, so a page can list one full saying.
    assert.deepEqual(families.variantsOf(byId.get('sai')).filter(v => v.common).map(v => v.simplified), ['塞翁失马焉知非福']);
    assert.deepEqual(families.variantsOf(byId.get('x1')), []);
    // Each sense of a variant headword is listed; senses of one's own headword are not variants.
    assert.deepEqual(families.variantsOf(byId.get('pair')).map(v => v.publicId), ['sense1', 'sense2']);
    assert.deepEqual(families.variantsOf(byId.get('sense1')).map(v => v.publicId), ['pair']);
});

test('collapse keeps ranked order and the first related form, and never drops another sense of the same headword', () => {
    assert.deepEqual(ids(families.collapse(ranked(['x1', 'zhong', 'x2', 'blind', 'xiazi', 'x3']))), ['x1', 'zhong', 'x2', 'x3']);
    assert.deepEqual(ids(families.collapse(ranked(['an', 'sai', 'yan']))), ['an']);
    assert.deepEqual(ids(families.collapse(ranked(['sai', 'an', 'yan']))), ['sai']);
    // Couplet halves both survive; the couplet is dropped once either half is kept.
    assert.deepEqual(ids(families.collapse(ranked(['hua', 'jia', 'couplet']))), ['hua', 'jia']);
    assert.deepEqual(ids(families.collapse(ranked(['couplet', 'hua', 'jia']))), ['couplet']);
    assert.deepEqual(ids(families.collapse(ranked(['sense1', 'pair', 'sense2']))), ['sense1', 'sense2']);
    // Results without an item resolve their headword by id.
    assert.deepEqual(ids(families.collapse([{ id: 'blind' }, { id: 'xiazi' }, { id: 'x1' }])), ['blind', 'x1']);
});

test('rankCollapsed grows the raw window until the collapsed list fills, and smaller windows are prefixes of larger ones', async () => {
    const order = ['xiazi', 'x1', 'blind', 'x2', 'zhong', 'x3', 'x4', 'x5', 'x6'];
    const windows = [];
    const rank = window => { windows.push(window); return ranked(order).slice(0, window); };
    const full = ids(await rankCollapsed(families, 50, rank));
    assert.deepEqual(full, ['xiazi', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6']);
    for (let needed = 1; needed <= 9; needed++) {
        windows.length = 0;
        const got = ids(await rankCollapsed(families, needed, rank));
        assert.deepEqual(got.slice(0, needed), full.slice(0, needed), `needed ${needed}`);
        assert.ok(got.length >= Math.min(needed, full.length));
        assert.equal(windows[0], needed);
    }
    assert.deepEqual(ids(await rankCollapsed(null, 3, rank)), ['xiazi', 'x1', 'blind'], 'grouping off is the raw ranking');
    // The growth cap bounds work on pathological lists.
    windows.length = 0;
    const sameIdiom = ranked(['blind', 'xiazi', 'zhong']);
    await rankCollapsed(families, 2, w => { windows.push(w); return Array.from({ length: w }, (_r, i) => sameIdiom[i && 1 + i % 2]); });
    assert.deepEqual(windows, [2, 4, 8]);
});

test('switch and loader: VARIANT_GROUPING=0, missing or invalid files turn grouping off with one log line; never throw', () => {
    assert.equal(isVariantGroupingEnabled({}), true);
    for (const value of ['0', 'false', 'off', 'no']) assert.equal(isVariantGroupingEnabled({ VARIANT_GROUPING: value }), false);
    assert.equal(isVariantGroupingEnabled({ VARIANT_GROUPING: '1' }), true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'));
    try {
        const logs = [], errors = [];
        const load = (filePath, env = {}) => loadVariantFamilies({ filePath, database: DB, env,
            logInfo: m => logs.push(m), logError: m => errors.push(m) });
        const good = path.join(dir, 'good.json'); fs.writeFileSync(good, JSON.stringify(MAP));
        assert.equal(load(good).version, 'unit');
        assert.equal(load(good, { VARIANT_GROUPING: '0' }), null);
        assert.equal(load(path.join(dir, 'missing.json')), null);
        const broken = path.join(dir, 'broken.json'); fs.writeFileSync(broken, '{ not json');
        assert.equal(load(broken), null);
        const invalid = path.join(dir, 'invalid.json'); fs.writeFileSync(invalid, JSON.stringify({ version: 'v', links: [link('盲人摸象', '无')] }));
        assert.equal(load(invalid), null);
        assert.equal(logs.length, 3); assert.equal(errors.length, 2);
        assert.match(errors[1], /not a corpus headword/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the checked-in map and the test fixture both validate against the real corpus', async () => {
    const { database } = await loadChengyuCorpus();
    for (const file of [FIXTURE, path.join(__dirname, '..', 'data', 'variant-families.json')]) {
        const map = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(createVariantFamilies(map, database).linkCount > 0, file);
    }
});

// Real corpus, real keyword/hybrid rankers, grouping on vs off.
async function corpusServices() {
    const { database, byId: corpusById } = await loadChengyuCorpus();
    const corpusFamilies = createVariantFamilies(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), database);
    const make = variantFamilies => createSearchExecutionService({
        getDatabase: () => database, getEmbeddings: () => null, isEmbeddingModelReady: () => false,
        rankedResultCache: new TTLCache(50, 60000), recordCacheOutcome() {},
        createHttpError: (statusCode, payload) => Object.assign(new Error(payload.error), { statusCode }),
        createPaginatedSearchResponse: options => createPaginatedSearchResponse({ ...options, byId: corpusById, variantFamilies }),
        loadFreshSearchConfig: () => require('../src/search/search-config.js'), loadHybridOverrides: () => ({}),
        generateQueryEmbedding: async () => null, getCrossEncoderSearchOption: () => ({}),
        getVariantFamilies: () => variantFamilies
    });
    return { database, families: corpusFamilies, on: make(corpusFamilies), off: make(null) };
}

test('every route collapses before pagination: pages, hasMore and offsets agree with one big page', async () => {
    const { families: corpusFamilies, on, off } = await corpusServices();
    const headword = r => r.simplified;
    const cases = [['executeKeywordSearch', '摸象'], ['executeHybridSearch', 'mo xiang'], ['executeHybridSearch', '塞翁'],
        ['executeAutoSearch', '摸象'], ['executeAutoSearch', 'blind men touching an elephant']];
    for (const [method, query] of cases) {
        const rawAll = (await off[method](query, { offset: 0, limit: 50 })).results;
        const all = await on[method](query, { offset: 0, limit: 50 });
        // Grouping on equals grouping off with related later forms removed.
        // Each kept result is then shown in its family's most common form.
        const expected = corpusFamilies.collapse(rawAll.map(r => ({ id: r.id, chengyu: r.chengyu, item: r })))
            .map(r => ({ id: all.mode === 'semantic' ? corpusFamilies.displayEntry(r.item, query).id : r.id }));
        // (The grouped list may run further: it refills from a larger raw window.)
        assert.deepEqual(ids(all.results.slice(0, expected.length)), ids(expected), `${method} ${query}`);
        if (rawAll.length < 50) assert.equal(all.results.length, expected.length);
        else assert.equal(all.results.length, 50, 'collapsed slots are refilled');
        assert.ok(expected.length < rawAll.length, `${method} ${query} has a variant to collapse`);
        for (const [i, a] of all.results.entries()) {
            for (const b of all.results.slice(i + 1)) assert.ok(!corpusFamilies.areRelated(headword(a), headword(b)), `${a.simplified} / ${b.simplified}`);
        }
        for (const limit of [1, 2, 3, 10]) {
            const pages = [];
            for (let offset = 0; offset + limit <= 50; offset += limit) {
                const page = await on[method](query, { offset, limit });
                assert.equal(page.offset, offset);
                pages.push(...page.results);
                // The 50-result window cap reports no more, as without grouping.
                const hasMore = offset + limit < 50 && all.results.length > offset + limit;
                assert.equal(page.hasMore, hasMore, `${method} ${query} hasMore at ${offset}/${limit}`);
                assert.equal(page.nextOffset, hasMore ? offset + limit : null);
                if (!page.hasMore) break;
            }
            assert.deepEqual(ids(pages), ids(all.results.slice(0, pages.length)), `${method} ${query} paged by ${limit}`);
            assert.ok(pages.length >= Math.min(all.results.length, 48));
        }
    }
});

test('exact lookup of any form returns that form first with its family; senses of the bookmark refresh stay reachable by id', async () => {
    const { database, families: corpusFamilies, on } = await corpusServices();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const forms = [...new Set(fixture.links.flatMap(l => [l.a, l.b]))];
    for (const form of forms) {
        for (const method of ['executeKeywordSearch', 'executeAutoSearch', 'executeHybridSearch']) {
            const response = await on[method](form, { offset: 0, limit: 10 });
            assert.equal(response.results[0].simplified, form, `${method} ${form}`);
            const expected = corpusFamilies.variantsOf(database.find(e => e.simplified === form)).map(v => v.publicId);
            assert.ok(expected.length > 0);
            assert.deepEqual(response.results[0].variants.map(v => v.publicId), expected);
        }
        // public/frontend-api.js refreshes a bookmark by keyword-searching its headword and matching the id.
        const bookmarked = database.filter(e => e.simplified === form);
        const refreshed = (await on.executeKeywordSearch(form, { offset: 0, limit: 10 })).results;
        for (const saved of bookmarked) assert.ok(refreshed.some(r => r.id === saved.id), `bookmark ${form}`);
    }
});

test('every result carries a variants array, empty when grouping is off or the idiom has no variants', async () => {
    const { on, off } = await corpusServices();
    for (const service of [on, off]) {
        for (const query of ['摸象', '一心一意', 'yi xin yi yi']) {
            const { results } = await service.executeAutoSearch(query, { limit: 10 });
            assert.ok(results.length);
            for (const result of results) assert.ok(Array.isArray(result.variants), query);
        }
    }
    const offResults = (await off.executeKeywordSearch('摸象', { limit: 10 })).results;
    assert.ok(offResults.every(r => r.variants.length === 0));
    assert.ok((await on.executeKeywordSearch('一心一意', { limit: 10 })).results.every(r => r.variants.length === 0));
});

test('hosted Qwen results and their continuations collapse before pagination', async () => {
    // Descending similarity to the query vector, in this order.
    const order = ['xiazi', 'x1', 'blind', 'x2', 'zhong', 'x3', 'x4', 'x5', 'x6'];
    const database = order.map(id => byId.get(id));
    const unit = i => { const v = Array(1024).fill(0); v[0] = Math.cos(i * 0.15); v[1] = Math.sin(i * 0.15); return v; };
    const index = readQwenIndex(writeQwenIndex(database, order.map((_id, i) => unit(i)), { neurons: 1 }).buffer, database);
    const query = '一群看不见的人各自摸到大象的一部分就下结论';
    const local = new Map(database.map(e => [e.id, e]));
    const search = variantFamilies => withHostedSearch({
        mode: 'auto', getDatabase: () => database, getIndex: () => index, isFallbackReady: () => false,
        client: { enabled: true, get: async () => ({ vector: null, reason: 'timeout', requestId: 'r1' }), peek: () => ({ vector: unit(0) }) },
        execute: async () => assert.fail('no lexical fallback for Chinese descriptions'), getVariantFamilies: () => variantFamilies,
        normalizePagination, createHttpError: (_code, body) => Error(body.error),
        createResponse: options => createPaginatedSearchResponse({ ...options, byId: local, variantFamilies })
    });
    const grouped = search(families);
    const first = await grouped(query, { limit: 2 });
    assert.equal(first.status, 'pending');
    // The ranker keeps 瞎子摸象; it is shown as its family's common form, 盲人摸象.
    const expected = ['blind', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
    const pages = [];
    for (let offset = 0; ; offset += 2) {
        const page = await grouped(query, { statusOnly: true, hostedRequestId: first.hostedRequestId, offset, limit: 2 });
        assert.equal(page.embeddingSource, 'hosted-qwen');
        pages.push(...page.results);
        assert.equal(page.hasMore, expected.length > offset + 2);
        if (!page.hasMore) break;
    }
    assert.deepEqual(ids(pages), expected);
    assert.deepEqual(pages[0].variants.map(v => v.publicId).sort(), ['xiazi', 'zhong']);
    const ungrouped = await search(null)(query, { statusOnly: true, hostedRequestId: 'r1', limit: 9 });
    assert.deepEqual(ids(ungrouped.results), order);
    assert.ok(ungrouped.results.every(r => r.variants.length === 0));
});

test('a kept result is shown in its family\'s most common form unless that form was typed exactly', () => {
    const fam = createVariantFamilies({ version: 'v', links: [
        link('盲人摸象', '瞎子摸象', 'same', 'a'), link('众盲摸象', '瞎子摸象', 'same', 'b'),
        link('塞翁失马', '塞翁失马焉知非福', 'full_form', 'a')
    ] }, DB);
    const show = (id, query) => fam.displayEntry(byId.get(id), query).id;
    // 盲人摸象 wins both votes it takes part in; 瞎子摸象 wins one and loses one.
    assert.equal(show('xiazi', 'blind men and an elephant'), 'blind');
    assert.equal(show('zhong', 'blind men and an elephant'), 'blind');
    assert.equal(show('blind', 'anything'), 'blind');
    // Typed characters (simplified or traditional) or pinyin keep the typed form.
    assert.equal(show('xiazi', '瞎子摸象'), 'xiazi');
    assert.equal(show('xiazi', ' 瞎子摸象。'), 'xiazi');
    assert.equal(show('xiazi', '瞎子摸象T'), 'xiazi');
    assert.equal(show('xiazi', 'PY-XIAZI'), 'xiazi');
    // full_form links never swap the displayed form; unlinked entries are untouched.
    assert.equal(show('yan', 'a blessing in disguise'), 'yan');
    assert.equal(show('x1', 'q'), 'x1');
});

test('a map headline shows a full saying as its short form; nothing else crosses a full_form link', () => {
    const links = [link('塞翁失马', '塞翁失马焉知非福', 'full_form', 'a'), link('塞翁失马焉知非福', '塞翁失马安知非福', 'same', 'a'),
        link('百花齐放', '百花齐放，百家争鸣', 'full_form', 'a')];
    const fam = createVariantFamilies({ version: 'v', links, headlines: [{ short: '塞翁失马', full: '塞翁失马焉知非福' }] }, DB);
    const show = (id, query = 'a meaning search') => fam.displayEntry(byId.get(id), query).id;
    // The whole full-saying cluster shows the short form, unless a form was typed.
    assert.equal(show('yan'), 'sai');
    assert.equal(show('an'), 'sai');
    assert.equal(show('yan', '塞翁失马焉知非福'), 'yan');
    assert.deepEqual(fam.variantsOf(byId.get('yan')).filter(v => v.preferred).map(v => v.simplified), ['塞翁失马']);
    // Pairs without a headline keep the ranked form.
    assert.equal(show('couplet'), 'couplet');
    // A headline must name corpus headwords joined by a full_form link.
    assert.throws(() => createVariantFamilies({ version: 'v', links, headlines: [{ short: '盲人摸象', full: '塞翁失马焉知非福' }] }, DB), /needs a full_form link/);
    assert.throws(() => createVariantFamilies({ version: 'v', links, headlines: [{ short: '没有', full: '塞翁失马焉知非福' }] }, DB), /not a corpus headword/);
    assert.throws(() => createVariantFamilies({ version: 'v', links, headlines: {} }, DB), /headlines must be an array/);
});

test('response payloads show the common form, keep the ranked score, and list the family', () => {
    const fam = createVariantFamilies({ version: 'v', links: [link('盲人摸象', '瞎子摸象', 'same', 'a')] }, DB);
    const response = createPaginatedSearchResponse({ query: 'blind men', mode: 'semantic', rankedResults: ranked(['xiazi', 'x1']), byId, variantFamilies: fam, limit: 5 });
    assert.deepEqual(response.results.map(r => r.simplified), ['盲人摸象', '甲']);
    assert.equal(response.results[0].relevance_score, createPaginatedSearchResponse({ query: 'blind men', mode: 'semantic', rankedResults: ranked(['xiazi']), byId, limit: 1 }).results[0].relevance_score);
    assert.deepEqual(response.results[0].variants.map(v => v.simplified), ['瞎子摸象']);
    const typed = createPaginatedSearchResponse({ query: '瞎子摸象', mode: 'semantic', rankedResults: ranked(['xiazi']), byId, variantFamilies: fam, limit: 5 });
    assert.deepEqual(typed.results.map(r => r.simplified), ['瞎子摸象']);
    assert.deepEqual(typed.results[0].variants.map(v => v.simplified), ['盲人摸象']);
    // Character and pinyin searches show the form that matched.
    for (const mode of ['keyword', 'hybrid']) {
        const lexical = createPaginatedSearchResponse({ query: '摸象', mode, rankedResults: ranked(['xiazi']), byId, variantFamilies: fam, limit: 5 });
        assert.deepEqual(lexical.results.map(r => r.simplified), ['瞎子摸象'], mode);
    }
});

const { withStableChengyuIds } = require('./chengyu-identity.js');
const {
    getCedictVariantIndices,
    normalizeCedictPinyinKey
} = require('./cedict-variants.js');

function enrichChengyuEntryWithVariants(entry) {
    const { bySimplifiedAndPinyin, bySimplified } = getCedictVariantIndices();
    const simplified = entry.chengyu;
    const pinyinKey = normalizeCedictPinyinKey(entry.pinyin);
    const cedictEntry = bySimplifiedAndPinyin.get(`${simplified}::${pinyinKey}`) || bySimplified.get(simplified);

    return {
        ...entry,
        simplified,
        traditional: cedictEntry?.traditional || simplified
    };
}

async function loadChengyuCorpus({
    corpus = null,
    logInfo = () => {},
    logError = console.error
} = {}) {
    logInfo('📚 Loading chengyu database...');
    try {
        const loadedCorpus = corpus || require('../../chengyuData.js');
        const database = withStableChengyuIds(loadedCorpus.map(enrichChengyuEntryWithVariants));
        const byId = new Map(database.map(entry => [entry.id, entry]));
        logInfo(`✓ Loaded ${database.length} chengyu entries`);
        return {
            ok: true,
            database,
            byId
        };
    } catch (error) {
        logError('❌ Error loading chengyu database:', error);
        return {
            ok: false,
            database: [],
            byId: new Map()
        };
    }
}

module.exports = {
    enrichChengyuEntryWithVariants,
    loadChengyuCorpus
};

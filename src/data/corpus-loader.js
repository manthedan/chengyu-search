/** @ts-check */

const { withStableChengyuIds } = require('./chengyu-identity.js');
const {
    getCedictVariantIndices,
    normalizeCedictPinyinKey
} = require('./cedict-variants.js');

/**
 * @typedef {import('../search/types').ChengyuEntry} ChengyuEntry
 * @typedef {ChengyuEntry & { id: string, publicId?: string, embeddingId?: string }} StableChengyuEntry
 * @typedef {(message: string, ...args: unknown[]) => void} LogFn
 * @typedef {object} LoadCorpusOptions
 * @property {ChengyuEntry[] | null} [corpus]
 * @property {LogFn} [logInfo]
 * @property {LogFn} [logError]
 * @typedef {object} LoadCorpusResult
 * @property {boolean} ok
 * @property {StableChengyuEntry[]} database
 * @property {Map<string, StableChengyuEntry>} byId
 */

/**
 * @param {ChengyuEntry} entry
 * @returns {ChengyuEntry}
 */
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

/**
 * @param {LoadCorpusOptions} [options]
 * @returns {Promise<LoadCorpusResult>}
 */
async function loadChengyuCorpus({
    corpus = null,
    logInfo = () => {},
    logError = console.error
} = {}) {
    logInfo('📚 Loading chengyu database...');
    try {
        const loadedCorpus = /** @type {ChengyuEntry[]} */ (corpus || require('../../chengyuData.js'));
        const database = /** @type {StableChengyuEntry[]} */ (withStableChengyuIds(loadedCorpus.map(enrichChengyuEntryWithVariants)));
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

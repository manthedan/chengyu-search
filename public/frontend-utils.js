(function attachFrontendUtils(global) {
    'use strict';

    function createEmptySearchState() {
        return {
            query: '',
            mode: null,
            queryType: null,
            preferredMode: null,
            autoRouted: false,
            fallbackFrom: null,
            loadedCount: 0,
            hasMore: false,
            nextOffset: null
        };
    }

    function normalizeBookmarkRecord(record, fallbackChengyu = '') {
        if (!record || typeof record !== 'object') {
            return null;
        }

        const chengyu = record.chengyu || fallbackChengyu;
        if (!chengyu) {
            return null;
        }

        return {
            id: typeof record.id === 'string' && record.id.length > 0 ? record.id : '',
            chengyu,
            simplified: typeof record.simplified === 'string' ? record.simplified : chengyu,
            traditional: typeof record.traditional === 'string' ? record.traditional : '',
            pinyin: typeof record.pinyin === 'string' ? record.pinyin : '',
            literal: typeof record.literal === 'string' ? record.literal : '',
            meaning: typeof record.meaning === 'string' ? record.meaning : '',
            example: typeof record.example === 'string' ? record.example : '',
            tags: Array.isArray(record.tags) ? [...record.tags] : [],
            formality: typeof record.formality === 'string' ? record.formality : ''
        };
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const TONE_MARKS = { 1: '\u0304', 2: '\u0301', 3: '\u030C', 4: '\u0300', 5: '' };

    function toToneMarkedSyllable(syllable) {
        const match = String(syllable || '').match(/^([a-züv:]+)([1-5])$/i);
        if (!match) return syllable;

        let [, base, tone] = match;
        base = base.toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');

        let index = -1;
        if (base.includes('a')) index = base.indexOf('a');
        else if (base.includes('o')) index = base.indexOf('o');
        else if (base.includes('e')) index = base.indexOf('e');
        else if (base.includes('iu')) index = base.indexOf('u');
        else if (base.includes('ui')) index = base.indexOf('i');
        else {
            for (const vowel of ['i', 'u', 'ü']) {
                const candidateIndex = base.indexOf(vowel);
                if (candidateIndex >= 0) {
                    index = candidateIndex;
                    break;
                }
            }
        }

        if (index < 0) return base;
        return `${base.slice(0, index + 1)}${TONE_MARKS[Number(tone)]}${base.slice(index + 1)}`;
    }

    function toneMarkPinyinString(pinyin) {
        return String(pinyin || '').replace(/[a-züv:]+[1-5]/gi, token => toToneMarkedSyllable(token));
    }

    function extractToneMarkedPinyinSyllables(pinyin) {
        const tokens = String(pinyin || '').match(/[a-züv:]+[1-5]?/gi) || [];
        return tokens.map(token => toToneMarkedSyllable(token));
    }

    function containsChineseCharacter(char) {
        return /[\u3400-\u9fff]/.test(char);
    }

    function buildCharacterPins(chengyu, pinyin) {
        const syllables = extractToneMarkedPinyinSyllables(pinyin);
        let syllableIndex = 0;

        return Array.from(String(chengyu || '')).map(char => {
            if (!containsChineseCharacter(char)) {
                return { char, pin: '', punctuation: true };
            }
            const pin = syllables[syllableIndex] || '';
            syllableIndex += 1;
            return { char, pin, punctuation: false };
        });
    }

    function splitExampleText(example) {
        const text = String(example || '').trim();
        if (!text) {
            return { zh: '', en: '' };
        }

        const match = text.match(/^(.*?)(?:[（(]([^()（）]+)[）)])?\s*$/);
        if (!match) {
            return { zh: text, en: '' };
        }

        return {
            zh: (match[1] || '').trim(),
            en: (match[2] || '').trim()
        };
    }

    global.ChengyuFrontendUtils = {
        createEmptySearchState,
        normalizeBookmarkRecord,
        escapeHtml,
        escapeRegExp,
        toToneMarkedSyllable,
        toneMarkPinyinString,
        extractToneMarkedPinyinSyllables,
        containsChineseCharacter,
        buildCharacterPins,
        splitExampleText
    };
})(window);

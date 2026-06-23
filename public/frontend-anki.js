(function attachFrontendAnki(global) {
    'use strict';

    function createAnkiExporter({
        escapeHtml,
        toneMarkPinyinString,
        getDisplayHeadword,
        documentRef = global.document,
        urlApi = global.URL,
        BlobCtor = global.Blob
    } = {}) {
        if (!escapeHtml || !toneMarkPinyinString || !getDisplayHeadword) {
            throw new Error('escapeHtml, toneMarkPinyinString, and getDisplayHeadword are required');
        }

        function sanitizeAnkiField(value) {
            return escapeHtml(String(value ?? ''))
                .replace(/\t/g, ' ')
                .replace(/\r?\n+/g, '<br>');
        }

        function buildAnkiFieldColumns(result) {
            return [
                sanitizeAnkiField(getDisplayHeadword(result)),
                sanitizeAnkiField(result.simplified || result.chengyu),
                sanitizeAnkiField(result.traditional || result.chengyu),
                sanitizeAnkiField(result.pinyin || ''),
                sanitizeAnkiField(toneMarkPinyinString(result.pinyin)),
                sanitizeAnkiField(result.meaning || ''),
                sanitizeAnkiField(result.literal || ''),
                sanitizeAnkiField(result.example || ''),
                sanitizeAnkiField(Array.isArray(result.tags) ? result.tags.join(', ') : ''),
                sanitizeAnkiField(result.formality || '')
            ];
        }

        function buildAnkiExportContent(results) {
            const rows = results.map(result => buildAnkiFieldColumns(result).join('\t'));

            return [
                '#separator:tab',
                '#html:true',
                ...rows
            ].join('\n');
        }

        function downloadTextFile({ filename, content, type }) {
            const blob = new BlobCtor([content], { type });
            const url = urlApi.createObjectURL(blob);
            const link = documentRef.createElement('a');
            link.href = url;
            link.download = filename;
            documentRef.body.append(link);
            link.click();
            link.remove();
            urlApi.revokeObjectURL(url);
        }

        return {
            sanitizeAnkiField,
            buildAnkiFieldColumns,
            buildAnkiExportContent,
            downloadTextFile
        };
    }

    global.ChengyuFrontendAnki = {
        createAnkiExporter
    };
})(window);

(function attachFrontendDictionary(global) {
    'use strict';

    const DEFAULT_POPOVER_ID = 'dictionary-popover';

    function createDictionaryController({
        escapeHtml,
        escapeRegExp,
        toneMarkPinyinString,
        splitExampleText,
        buildCharacterPins,
        getDisplayHeadword,
        getScriptMode,
        documentRef = global.document,
        windowRef = global,
        fetchFn = global.fetch,
        consoleRef = global.console,
        popoverId = DEFAULT_POPOVER_ID
    } = {}) {
        if (!escapeHtml || !escapeRegExp || !toneMarkPinyinString || !splitExampleText || !buildCharacterPins || !getDisplayHeadword || !getScriptMode) {
            throw new Error('dictionary helpers require utility and display dependencies');
        }

        const dictionary = {
            entries: new Map(),
            annotations: {},
            charIndex: new Map(),
            loaded: false,
            loading: false
        };

        async function loadDictionaryData() {
            if (dictionary.loaded || dictionary.loading) return;
            dictionary.loading = true;
            try {
                const [dictRes, annRes] = await Promise.all([
                    fetchFn('/generated/dictionary-subset.json'),
                    fetchFn('/generated/example-annotations.json')
                ]);
                if (!dictRes.ok || !annRes.ok) throw new Error('Dictionary fetch failed');
                const [dictData, annData] = await Promise.all([dictRes.json(), annRes.json()]);
                dictionary.entries = new Map(dictData.map(e => [e.id, e]));
                dictionary.annotations = annData;
                // Build character index from single-character entries only.
                // Index both simplified and traditional forms so tooltips work in both script modes.
                const charBest = new Map();
                for (const entry of dictData) {
                    if (entry.simplified && entry.simplified.length === 1) {
                        charBest.set(entry.simplified, entry);
                        if (entry.traditional && entry.traditional !== entry.simplified) {
                            charBest.set(entry.traditional, entry);
                        }
                    }
                }
                dictionary.charIndex = charBest;
                dictionary.loaded = true;
            } catch (err) {
                consoleRef.error('Dictionary load failed:', err);
            } finally {
                dictionary.loading = false;
            }
        }

        function findAnnotationForChengyu(chengyu, exampleText) {
            if (!dictionary.loaded) return null;
            const zhText = exampleText ? splitExampleText(exampleText).zh : '';
            for (const [, ann] of Object.entries(dictionary.annotations)) {
                if (ann.chengyu === chengyu) {
                    // For duplicate headwords, match by example text.
                    if (!zhText || ann.text === zhText) return ann;
                }
            }
            // Fallback: return first match if text didn't match any.
            for (const [, ann] of Object.entries(dictionary.annotations)) {
                if (ann.chengyu === chengyu) return ann;
            }
            return null;
        }

        function findDictionaryEntryById(id) {
            return dictionary.entries.get(id) || null;
        }

        function getDictionaryEntryForChar(char) {
            if (!dictionary.loaded) return null;
            return dictionary.charIndex.get(char) || null;
        }

        function renderPopover() {
            return `<div id="${popoverId}" class="dict-popover" role="dialog" aria-label="Dictionary definition" hidden></div>`;
        }

        function showPopover(targetEl, content) {
            let popover = documentRef.getElementById(popoverId);
            if (!popover) return;
            popover.innerHTML = content;
            popover.hidden = false;

            const rect = targetEl.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            const viewportWidth = windowRef.innerWidth;
            const viewportHeight = windowRef.innerHeight;

            let left = rect.left + rect.width / 2 - popRect.width / 2;
            left = Math.max(8, Math.min(left, viewportWidth - popRect.width - 8));

            let top = rect.bottom + 6;
            if (top + popRect.height > viewportHeight - 8) {
                top = rect.top - popRect.height - 6;
            }
            top = Math.max(8, top);

            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
        }

        function hidePopover() {
            const popover = documentRef.getElementById(popoverId);
            if (popover) {
                popover.hidden = true;
                popover.innerHTML = '';
            }
        }

        function buildPopoverContent(entries) {
            if (!entries || entries.length === 0) return '';
            const entry = entries[0];

            const simp = escapeHtml(entry.simplified || '');
            const trad = entry.traditional && entry.traditional !== entry.simplified
                ? `<span class="dict-pop-trad">${escapeHtml(entry.traditional)}</span>` : '';
            const pinyin = entry.pinyin ? `<div class="dict-pop-pinyin">${escapeHtml(toneMarkPinyinString(entry.pinyin))}</div>` : '';
            const literal = entry.literal ? `<div class="dict-pop-literal"><span class="arrow">—</span> &ldquo;${escapeHtml(entry.literal)}&rdquo;</div>` : '';
            const chengyuLabel = getScriptMode() === 'traditional' ? '成語' : '成语';
            const isChengyu = entry.isChengyu ? `<span class="dict-pop-tag">${chengyuLabel}</span>` : '';

            const defs = (entry.definitions || []).map(d =>
                `<li class="dict-pop-def">${escapeHtml(d)}</li>`
            ).join('');

            return `
                <div class="dict-pop-head">
                    <span class="dict-pop-word">${simp}</span>${trad}
                    ${isChengyu}
                </div>
                ${pinyin}
                ${literal}
                ${defs ? `<ol class="dict-pop-defs">${defs}</ol>` : ''}
            `;
        }

        function handleDictionaryClick(event) {
            // Check for example token click first.
            const token = event.target.closest('[data-dict-entry]');
            if (token) {
                event.preventDefault();
                event.stopPropagation();

                const entryIds = token.dataset.dictEntry;
                if (!entryIds) return;

                const entries = entryIds.split(',').map(id => findDictionaryEntryById(id)).filter(Boolean);
                if (entries.length === 0) return;

                showPopover(token, buildPopoverContent(entries));
                return;
            }

            // Check for character click on headword.
            const charEl = event.target.closest('[data-dict-char]');
            if (charEl) {
                event.preventDefault();
                event.stopPropagation();

                const char = charEl.dataset.dictChar;
                if (!char) return;

                const entry = getDictionaryEntryForChar(char);
                if (entry) {
                    showPopover(charEl, buildPopoverContent([entry]));
                }
                return;
            }

            // Click outside - close popover.
            if (!event.target.closest(`#${popoverId}`)) {
                hidePopover();
            }
        }

        function handleDictionaryKeydown(event) {
            if (event.key === 'Escape') {
                hidePopover();
            } else if ((event.key === 'Enter' || event.key === ' ')) {
                if (event.target.closest('[data-dict-entry]') || event.target.closest('[data-dict-char]')) {
                    event.preventDefault();
                    handleDictionaryClick(event);
                }
            }
        }

        function getExampleDisplayText(text, result) {
            const rawText = String(text || '');
            const canonicalIdiom = result?.chengyu;
            const displayIdiom = result ? getDisplayHeadword(result) : '';

            if (!rawText || !canonicalIdiom || !displayIdiom || canonicalIdiom === displayIdiom) {
                return rawText;
            }

            return rawText.split(canonicalIdiom).join(displayIdiom);
        }

        function highlightIdiomPlain(text, result) {
            const displayText = getExampleDisplayText(text, result);
            const displayIdiom = result ? getDisplayHeadword(result) : '';
            const escaped = escapeHtml(displayText);
            if (!displayText || !displayIdiom) return escaped;

            const pattern = new RegExp(escapeRegExp(escapeHtml(displayIdiom)), 'g');
            return escaped.replace(pattern, '<span class="highlight">$&</span>');
        }

        function renderAnnotatedExample(text, result) {
            if (!dictionary.loaded || !result) {
                return highlightIdiomPlain(text, result);
            }

            const annotation = findAnnotationForChengyu(result.chengyu, result.example);
            // Normalize: build script strips at first paren, so compare the same way.
            const normalizedText = String(text || '').match(/^([^(（]+)/)?.[1].trim() ?? text;
            if (!annotation || annotation.text !== normalizedText) {
                return highlightIdiomPlain(text, result);
            }

            const displayIdiom = getDisplayHeadword(result);
            const canonicalIdiom = result.chengyu;
            const isTraditional = getScriptMode() === 'traditional' && canonicalIdiom !== displayIdiom;

            return annotation.tokens.map(token => {
                if (token.nonChinese) {
                    return escapeHtml(token.text);
                }

                let displayText = token.text;
                // Convert to traditional if needed.
                if (isTraditional) {
                    // Try to get traditional form from the dictionary entry.
                    if (token.entryIds && token.entryIds.length > 0) {
                        const entry = findDictionaryEntryById(token.entryIds[0]);
                        if (entry && entry.traditional) {
                            displayText = entry.traditional;
                        }
                    }
                }

                const escapedDisplay = escapeHtml(displayText);
                const entryIds = (token.entryIds || []).filter(id => findDictionaryEntryById(id));

                if (entryIds.length === 0) {
                    if (token.uncovered) {
                        return `<span class="dict-token dict-uncovered">${escapedDisplay}</span>`;
                    }
                    return escapedDisplay;
                }

                const isChengyuToken = displayText === displayIdiom || token.text === canonicalIdiom;
                const highlightClass = isChengyuToken ? ' highlight' : '';
                const dataAttr = `data-dict-entry="${escapeHtml(entryIds.join(','))}"`;

                return `<span class="dict-token${highlightClass}"${dataAttr} tabindex="0" role="button">${escapedDisplay}</span>`;
            }).join('');
        }

        function highlightIdiomInText(text, result) {
            return renderAnnotatedExample(text, result);
        }

        function renderCharacterCluster(result) {
            const pins = buildCharacterPins(getDisplayHeadword(result), result.pinyin);

            // If dictionary loaded, try to group characters by segmented headword words.
            if (dictionary.loaded) {
                const annotation = findAnnotationForChengyu(result.chengyu, result.example);
                if (annotation && annotation.headwordTokens) {
                    return renderSegmentedHeadword(pins, annotation.headwordTokens);
                }
            }

            // Fallback: individual clickable characters.
            return pins.map(item => {
                if (item.punctuation) {
                    return `<span class="ch punct">${escapeHtml(item.char)}</span>`;
                }

                const dictAttrs = dictionary.loaded
                    ? ` data-dict-char="${escapeHtml(item.char)}" tabindex="0" role="button"`
                    : '';

                return `
                    <span class="ch"${dictAttrs}>
                        <span class="pin">${escapeHtml(item.pin)}</span>${escapeHtml(item.char)}
                    </span>
                `;
            }).join('');
        }

        function renderSegmentedHeadword(pins, headwordTokens) {
            // Align headword tokens with character pins.
            // pins may contain traditional chars while headwordTokens use simplified.
            // We map by position: consume pins in order, grouping by headword token text.
            const result = [];
            let pinIdx = 0;

            for (const token of headwordTokens) {
                const tokenChars = Array.from(token.text);
                const tokenPins = [];
                for (const tc of tokenChars) {
                    // Find the next matching pin (skip punctuation pins if needed).
                    while (pinIdx < pins.length) {
                        const pin = pins[pinIdx];
                        pinIdx++;
                        tokenPins.push(pin);
                        break;
                    }
                }

                const isPunct = tokenPins.length === 1 && tokenPins[0].punctuation;
                const entryIds = (token.entryIds || []).filter(id => findDictionaryEntryById(id));

                if (isPunct) {
                    result.push(`<span class="ch punct">${escapeHtml(token.text)}</span>`);
                } else if (entryIds.length > 0) {
                    // Wrap individual .ch spans in a clickable group to preserve pinyin positioning.
                    const dataAttr = `data-dict-entry="${escapeHtml(entryIds.join(','))}"`;
                    const charSpans = tokenPins.map(p =>
                        p.pin
                            ? `<span class="ch"><span class="pin">${escapeHtml(p.pin)}</span>${escapeHtml(p.char)}</span>`
                            : `<span class="ch">${escapeHtml(p.char)}</span>`
                    ).join('');
                    result.push(`<span class="ch-word" ${dataAttr} tabindex="0" role="button">${charSpans}</span>`);
                } else {
                    // No dictionary entry - render chars with individual char lookup.
                    for (const p of tokenPins) {
                        if (p.punctuation) {
                            result.push(`<span class="ch punct">${escapeHtml(p.char)}</span>`);
                        } else {
                            result.push(`<span class="ch" data-dict-char="${escapeHtml(p.char)}" tabindex="0" role="button"><span class="pin">${escapeHtml(p.pin)}</span>${escapeHtml(p.char)}</span>`);
                        }
                    }
                }
            }

            return result.join('');
        }

        return {
            dictionary,
            popoverId,
            loadDictionaryData,
            findAnnotationForChengyu,
            findDictionaryEntryById,
            getDictionaryEntryForChar,
            renderPopover,
            showPopover,
            hidePopover,
            buildPopoverContent,
            handleDictionaryClick,
            handleDictionaryKeydown,
            getExampleDisplayText,
            renderAnnotatedExample,
            highlightIdiomPlain,
            highlightIdiomInText,
            renderCharacterCluster,
            renderSegmentedHeadword
        };
    }

    global.ChengyuFrontendDictionary = {
        createDictionaryController
    };
})(window);

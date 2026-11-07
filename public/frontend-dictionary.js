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
        popoverId = DEFAULT_POPOVER_ID,
        onPopoverShow = null
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
            // The scrim only shows where the popover is a bottom sheet (CSS);
            // tapping it closes the sheet instead of the content beneath. The
            // caret points from a floating popover back at its glyph or word.
            return `<div class="dict-scrim" data-dict-close aria-hidden="true" hidden></div><div id="${popoverId}" class="dict-popover" role="dialog" aria-label="Dictionary definition" hidden></div><span class="dict-caret" aria-hidden="true" hidden></span>`;
        }

        let activeTarget = null;
        let repositionBound = false;

        function getCaret(popover) {
            const next = popover?.nextElementSibling;
            return next?.classList?.contains('dict-caret') ? next : null;
        }

        function setActiveTarget(targetEl) {
            if (activeTarget && activeTarget !== targetEl) {
                activeTarget.classList?.remove('is-dict-active');
                activeTarget.removeAttribute?.('aria-expanded');
            }
            activeTarget = targetEl || null;
            if (activeTarget) {
                activeTarget.classList?.add('is-dict-active');
                activeTarget.setAttribute?.('aria-expanded', 'true');
            }
        }

        function showPopover(targetEl, content) {
            let popover = documentRef.getElementById(popoverId);
            if (!popover) return;
            popover.innerHTML = content;
            popover.hidden = false;
            const scrim = popover.previousElementSibling;
            if (scrim?.classList?.contains('dict-scrim')) scrim.hidden = false;
            setActiveTarget(targetEl);
            positionPopover(popover, targetEl);
            bindReposition();
            onPopoverShow?.();
        }

        // A floating popover opens below its glyph or word, caret pointing
        // up, and flips above only when there is no room below. It never
        // covers its target, the search box or the sticky search bar; it may
        // briefly cover other content, as a transient popover.
        function getPlacementContext(targetEl) {
            const rect = targetEl.getBoundingClientRect();
            const bottoms = ['.search-box', 'body.show-sticky-search .sticky-search']
                .map(selector => documentRef.querySelector?.(selector)?.getBoundingClientRect?.()?.bottom || 0);
            const minTop = Math.max(0, ...bottoms);
            return { rect, minTop, sides: ['below', 'above'] };
        }

        function positionPopover(popover, targetEl) {
            popover.style.maxHeight = '';
            const caret = getCaret(popover);
            const sheet = windowRef.matchMedia?.('(max-width: 640px)')?.matches;
            if (sheet) {
                if (caret) caret.hidden = true;
                return;
            }
            const context = getPlacementContext(targetEl);
            const placement = placePopover(
                context.rect,
                popover.getBoundingClientRect(),
                { width: windowRef.innerWidth, height: windowRef.innerHeight },
                context
            );
            popover.style.left = `${placement.left}px`;
            popover.style.top = `${placement.top}px`;
            if (placement.maxHeight) popover.style.maxHeight = `${placement.maxHeight}px`;
            popover.dataset.placement = placement.side;
            if (caret) {
                caret.hidden = false;
                caret.dataset.placement = placement.side;
                const edge = placement.side === 'below'
                    ? placement.top
                    : placement.top + (placement.maxHeight || popover.getBoundingClientRect().height);
                caret.style.left = `${placement.caretX - 6}px`;
                caret.style.top = `${edge - 6}px`;
            }
        }

        function placePopover(rect, popRect, viewport, { minTop = 0, sides = ['below', 'above'] } = {}) {
            const gap = 9;
            const margin = 8;
            const top0 = Math.max(margin, minTop + gap);
            const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - popRect.width / 2, viewport.width - popRect.width - margin));
            const caretX = Math.max(left + 16, Math.min(rect.left + rect.width / 2, left + popRect.width - 16));
            const belowTop = rect.bottom + gap;
            const aboveTop = rect.top - gap - popRect.height;
            const spaceBelow = viewport.height - margin - belowTop;
            const spaceAbove = rect.top - gap - top0;
            const fits = {
                above: popRect.height <= spaceAbove,
                below: popRect.height <= spaceBelow
            };
            const side = sides.find(name => fits[name]);
            if (side === 'below') return { side, left, top: belowTop, caretX };
            if (side === 'above') return { side, left, top: aboveTop, caretX };
            // Nothing fits whole: use the roomier of above and below and let
            // the popover scroll.
            if (spaceBelow >= spaceAbove) {
                return { side: 'below', left, top: belowTop, caretX, maxHeight: Math.max(120, spaceBelow) };
            }
            return { side: 'above', left, top: top0, caretX, maxHeight: Math.max(120, spaceAbove) };
        }

        // A floating popover follows its target when the page scrolls or
        // resizes, so the caret keeps pointing at the right glyph.
        function bindReposition() {
            if (repositionBound || !windowRef.addEventListener) return;
            repositionBound = true;
            let frame = 0;
            const update = () => {
                frame = 0;
                const popover = documentRef.getElementById(popoverId);
                if (!popover || popover.hidden || !activeTarget?.isConnected) return;
                positionPopover(popover, activeTarget);
            };
            const schedule = () => {
                if (!frame) frame = (windowRef.requestAnimationFrame || (fn => setTimeout(fn, 16)))(update);
            };
            windowRef.addEventListener('scroll', schedule, { passive: true });
            windowRef.addEventListener('resize', schedule);
        }

        function hidePopover() {
            const popover = documentRef.getElementById(popoverId);
            if (popover) {
                popover.hidden = true;
                popover.innerHTML = '';
                const scrim = popover.previousElementSibling;
                if (scrim?.classList?.contains('dict-scrim')) scrim.hidden = true;
                const caret = getCaret(popover);
                if (caret) caret.hidden = true;
            }
            setActiveTarget(null);
        }

        function buildPopoverContent(entries) {
            if (!entries || entries.length === 0) return '';
            const entry = entries[0];

            const simp = escapeHtml(entry.simplified || '');
            const trad = entry.traditional && entry.traditional !== entry.simplified
                ? `<span class="dict-pop-trad">${escapeHtml(entry.traditional)}</span>` : '';
            const pinyin = entry.pinyin ? `<div class="dict-pop-pinyin">${escapeHtml(toneMarkPinyinString(entry.pinyin))}</div>` : '';
            const literal = entry.literal ? `<div class="dict-pop-literal"><span class="lit-label">lit.</span> &ldquo;${escapeHtml(entry.literal)}&rdquo;</div>` : '';
            const chengyuLabel = getScriptMode() === 'traditional' ? '成語' : '成语';
            const isChengyu = entry.isChengyu ? `<span class="dict-pop-tag">${chengyuLabel}</span>` : '';

            const defs = (entry.definitions || []).map(d =>
                `<li class="dict-pop-def">${escapeHtml(d)}</li>`
            ).join('');

            // A word whose traditional form differs names both: 简 屡 · 繁 屢.
            const word = trad
                ? `<span class="dict-pop-script">简</span><span class="dict-pop-word">${simp}</span><span class="dict-pop-sep" aria-hidden="true">·</span><span class="dict-pop-script">繁</span>${trad}`
                : `<span class="dict-pop-word">${simp}</span>`;

            return `
                <div class="dict-pop-toolbar">
                    <span class="dict-pop-handle" aria-hidden="true"></span>
                    <span>Dictionary</span>
                    <button type="button" class="dict-pop-close" data-dict-close aria-label="Close dictionary">Close <span aria-hidden="true">×</span></button>
                </div>
                <div class="dict-pop-head">
                    ${word}
                    ${isChengyu}
                </div>
                ${pinyin}
                ${literal}
                ${defs ? `<ol class="dict-pop-defs">${defs}</ol>` : ''}
                ${simp && !entry.isChengyu ? `<button type="button" class="dict-pop-search" data-dict-search="${simp}">Idioms with <span class="dict-pop-search-word">${simp}</span> <span aria-hidden="true">→</span></button>` : ''}
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

        // Ruby pinyin sits over a fixed 1em glyph cell and never widens it.
        // Each syllable carries its natural width (--pw, in ems of the pinyin
        // face at its +0.02em tracking), its letter count (--pn) and the
        // width of its widest neighbour no wider than itself (--pwn), so the
        // stylesheet can tighten only a syllable too wide for its glyph or
        // for the space it shares with that neighbour.
        function pinClass() {
            return 'pin';
        }

        // Advance widths of the text serif's lowercase letters, in ems.
        const PIN_LETTER_EM = {
            a: 0.5, b: 0.56, c: 0.45, d: 0.57, e: 0.48, f: 0.33, g: 0.51, h: 0.58, i: 0.29,
            j: 0.29, k: 0.54, l: 0.29, m: 0.88, n: 0.59, o: 0.54, p: 0.57, q: 0.56, r: 0.41,
            s: 0.43, t: 0.35, u: 0.58, v: 0.5, w: 0.74, x: 0.5, y: 0.49, z: 0.44
        };
        const PIN_TRACKING_EM = 0.02;

        function pinMetrics(pin) {
            const letters = Array.from(String(pin || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
            const width = letters.reduce((sum, letter) => sum + (PIN_LETTER_EM[letter] ?? 0.5) + PIN_TRACKING_EM, 0);
            return { width: Math.round(width * 100) / 100, count: Math.max(1, letters.length) };
        }

        function pinStyle(pin, neighbourWidth = 0) {
            const { width, count } = pinMetrics(pin);
            return `--pw:${width};--pn:${count}${neighbourWidth ? `;--pwn:${neighbourWidth}` : ''}`;
        }

        // One style per pin. Neighbours are the adjacent glyphs on either
        // side; a comma cell separates them. Of two neighbours, only the
        // wider syllable (or both, when equal) gives way.
        function pinStyles(pins) {
            const widths = pins.map(item => (item.punctuation || !item.pin ? 0 : pinMetrics(item.pin).width));
            return pins.map((item, index) => {
                if (!widths[index]) return '';
                const neighbours = [widths[index - 1] || 0, widths[index + 1] || 0].filter(width => width && width <= widths[index]);
                return pinStyle(item.pin, neighbours.length ? Math.max(...neighbours) : 0);
            });
        }

        // Where a long idiom may break onto a second line: after a full-width
        // comma when it has one, otherwise after its fourth glyph (不到黄河 /
        // 心不死, 靡不有初， / 鲜克有终). The app's length classes decide which
        // layouts take the break. Returns the pin index the break follows, or -1.
        function headwordBreakIndex(pins) {
            const glyphs = pins.filter(item => !item.punctuation).length;
            if (glyphs <= 4) return -1;
            const comma = pins.findIndex((item, index) => item.punctuation && index > 0 && index < pins.length - 1);
            if (comma >= 0) return comma;
            let seen = 0;
            return pins.findIndex(item => !item.punctuation && ++seen === 4);
        }

        const HEADWORD_BREAK = '<span class="hw-break" aria-hidden="true"></span>';

        function renderPin(pin, style = pinStyle(pin)) {
            return `<span style="${style}" class="${pinClass(pin)}">${escapeHtml(pin)}</span>`;
        }

        function renderPunctuation(char) {
            return `<span class="ch punct">${escapeHtml(char)}</span>`;
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
            const breakAt = headwordBreakIndex(pins);
            const styles = pinStyles(pins);
            return pins.map((item, index) => {
                const after = index === breakAt ? HEADWORD_BREAK : '';
                if (item.punctuation) return renderPunctuation(item.char) + after;

                const dictAttrs = dictionary.loaded
                    ? ` data-dict-char="${escapeHtml(item.char)}" tabindex="0" role="button"`
                    : '';

                return `<span class="ch"${dictAttrs}>${renderPin(item.pin, styles[index])}${escapeHtml(item.char)}</span>${after}`;
            }).join('');
        }

        function renderSegmentedHeadword(pins, headwordTokens) {
            // Align headword tokens with character pins.
            // pins may contain traditional chars while headwordTokens use simplified.
            // We map by position: consume pins in order, grouping by headword token text.
            const result = [];
            let pinIdx = 0;
            const breakAt = headwordBreakIndex(pins);
            const styles = pinStyles(pins);
            const styleOf = new Map(pins.map((pin, index) => [pin, styles[index]]));
            let broken = breakAt < 0;

            for (const token of headwordTokens) {
                if (!broken && pinIdx > breakAt) {
                    result.push(HEADWORD_BREAK);
                    broken = true;
                }
                const tokenStart = pinIdx;
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
                    result.push(renderPunctuation(token.text));
                } else if (entryIds.length > 0) {
                    // Wrap individual .ch spans in a clickable group to preserve pinyin positioning.
                    const dataAttr = `data-dict-entry="${escapeHtml(entryIds.join(','))}"`;
                    const renderGroup = groupPins => `<span class="ch-word" ${dataAttr} tabindex="0" role="button">${groupPins.map(p =>
                        p.pin
                            ? `<span class="ch">${renderPin(p.pin, styleOf.get(p))}${escapeHtml(p.char)}</span>`
                            : `<span class="ch">${escapeHtml(p.char)}</span>`
                    ).join('')}</span>`;
                    // A word that straddles the line break splits into two
                    // groups that open the same entry.
                    const split = !broken && breakAt >= tokenStart && breakAt < pinIdx - 1 ? breakAt - tokenStart + 1 : 0;
                    if (split) {
                        result.push(renderGroup(tokenPins.slice(0, split)), HEADWORD_BREAK, renderGroup(tokenPins.slice(split)));
                        broken = true;
                    } else {
                        result.push(renderGroup(tokenPins));
                    }
                } else {
                    // No dictionary entry - render chars with individual char lookup.
                    tokenPins.forEach((p, offset) => {
                        if (p.punctuation) {
                            result.push(renderPunctuation(p.char));
                        } else {
                            result.push(`<span class="ch" data-dict-char="${escapeHtml(p.char)}" tabindex="0" role="button">${renderPin(p.pin, styleOf.get(p))}${escapeHtml(p.char)}</span>`);
                        }
                        if (!broken && tokenStart + offset === breakAt && offset < tokenPins.length - 1) {
                            result.push(HEADWORD_BREAK);
                            broken = true;
                        }
                    });
                }
            }
            if (!broken && pinIdx > breakAt) result.push(HEADWORD_BREAK);

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
            renderSegmentedHeadword,
            pinClass,
            renderPin,
            pinStyles,
            headwordBreakIndex,
            headwordBreak: HEADWORD_BREAK
        };
    }

    global.ChengyuFrontendDictionary = {
        createDictionaryController
    };
})(window);

(function attachFrontendSpeech(global) {
    'use strict';

    function createSpeechController({
        state,
        getResultPublicId,
        render,
        consoleRef = global.console,
        speechSynthesis = global.speechSynthesis,
        SpeechSynthesisUtteranceCtor = global.SpeechSynthesisUtterance,
        setTimeoutRef = global.setTimeout
    } = {}) {
        if (!state || !getResultPublicId || !render) {
            throw new Error('state, getResultPublicId, and render are required');
        }

        let activeUtterance = null;
        let voicesReadyPromise = null;

        function normalizeSpeechLang(lang) {
            return String(lang || '').toLowerCase().replace(/_/g, '-');
        }

        function scoreChineseVoice(voice) {
            const lang = normalizeSpeechLang(voice.lang);
            const name = String(voice.name || '').toLowerCase();

            let score = 0;
            if (lang === 'zh-cn' || lang.startsWith('cmn-cn') || lang.startsWith('zh-hans')) {
                score += 100;
            } else if (lang.startsWith('zh') || lang.startsWith('cmn')) {
                score += 70;
            } else {
                return -Infinity;
            }

            if (name.includes('mandarin') || name.includes('普通话')) score += 20;
            if (name.includes('ting-ting') || name.includes('tingting')) score += 10;
            if (name.includes('mei-jia') || name.includes('meijia')) score += 8;
            if (name.includes('sin-ji') || name.includes('sinji')) score += 5;
            if (name.includes('google')) score += 4;
            if (voice.localService) score += 3;
            if (voice.default) score += 2;
            if (lang.startsWith('zh-hk') || lang.startsWith('zh-tw')) score -= 5;

            return score;
        }

        function getSpeechVoices() {
            if (!speechSynthesis) {
                return Promise.resolve([]);
            }

            const current = speechSynthesis.getVoices();
            if (current.length > 0) {
                return Promise.resolve(current);
            }

            if (!voicesReadyPromise) {
                voicesReadyPromise = new Promise(resolve => {
                    let settled = false;

                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        resolve(speechSynthesis.getVoices());
                    };

                    const onVoicesChanged = () => {
                        speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
                        finish();
                    };

                    speechSynthesis.addEventListener?.('voiceschanged', onVoicesChanged);
                    setTimeoutRef(() => {
                        speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
                        finish();
                    }, 1000);
                });
            }

            return voicesReadyPromise;
        }

        async function pickBestChineseVoice() {
            const voices = await getSpeechVoices();
            return voices
                .map(voice => ({ voice, score: scoreChineseVoice(voice) }))
                .filter(entry => entry.score > -Infinity)
                .sort((a, b) => b.score - a.score)[0]?.voice || null;
        }

        function clearSpeakingState({ rerender = true } = {}) {
            if (!state.speakingChengyu) return;
            state.speakingChengyu = null;
            if (rerender) render();
        }

        async function pronounceResult(result) {
            if (!speechSynthesis || !SpeechSynthesisUtteranceCtor) {
                state.error = 'Browser speech synthesis is not available on this device.';
                render();
                return;
            }

            const resultId = getResultPublicId(result);
            if (state.speakingChengyu === resultId) {
                speechSynthesis.cancel();
                activeUtterance = null;
                clearSpeakingState();
                return;
            }

            try {
                const voice = await pickBestChineseVoice();
                if (!voice) {
                    state.error = 'No suitable Chinese voice is available in this browser. Try a browser or system voice set with Mandarin support.';
                    render();
                    return;
                }

                state.error = null;
                speechSynthesis.cancel();

                const utterance = new SpeechSynthesisUtteranceCtor(result.chengyu);
                activeUtterance = utterance;
                utterance.voice = voice;
                utterance.lang = voice.lang || 'zh-CN';
                utterance.rate = 0.72;
                utterance.pitch = 1;

                utterance.onstart = () => {
                    state.speakingChengyu = resultId;
                    render();
                };

                utterance.onend = () => {
                    if (activeUtterance !== utterance) {
                        return;
                    }
                    activeUtterance = null;
                    clearSpeakingState();
                };

                utterance.onerror = error => {
                    consoleRef.error('Pronunciation failed:', error);
                    if (activeUtterance !== utterance) {
                        return;
                    }
                    activeUtterance = null;
                    clearSpeakingState({ rerender: false });
                    state.error = 'Unable to pronounce this idiom in the browser right now.';
                    render();
                };

                speechSynthesis.speak(utterance);
            } catch (error) {
                consoleRef.error('Pronunciation failed:', error);
                activeUtterance = null;
                clearSpeakingState({ rerender: false });
                state.error = 'Unable to pronounce this idiom in the browser right now.';
                render();
            }
        }

        return {
            normalizeSpeechLang,
            scoreChineseVoice,
            getSpeechVoices,
            pickBestChineseVoice,
            clearSpeakingState,
            pronounceResult
        };
    }

    global.ChengyuFrontendSpeech = {
        createSpeechController
    };
})(window);

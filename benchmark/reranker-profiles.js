const RERANKER_PROFILES = {
    current: {
        id: 'current',
        label: 'Current promoted stack (no reranker)',
        override: null
    },
    'rerank-light': {
        id: 'rerank-light',
        label: 'Light semantic candidate reranker',
        override: {
            rerankTopK: 20,
            rerankBlendWeight: 0.15,
            rerankMeaningPhraseWeight: 0.8,
            rerankLiteralPhraseWeight: 0.6,
            rerankCoverageWeight: 0.5,
            rerankWeightedJaccardWeight: 0.35,
            rerankFocusedCoverageWeight: 0.2,
            rerankAllFocusedTokensBoost: 0.2,
            rerankBigramWeight: 0.35,
            rerankTrigramWeight: 0.15
        }
    },
    'rerank-medium': {
        id: 'rerank-medium',
        label: 'Medium semantic candidate reranker',
        override: {
            rerankTopK: 24,
            rerankBlendWeight: 0.25,
            rerankMeaningPhraseWeight: 1.0,
            rerankLiteralPhraseWeight: 0.7,
            rerankCoverageWeight: 0.65,
            rerankWeightedJaccardWeight: 0.45,
            rerankFocusedCoverageWeight: 0.3,
            rerankAllFocusedTokensBoost: 0.35,
            rerankBigramWeight: 0.45,
            rerankTrigramWeight: 0.2
        }
    },
    'rerank-targeted': {
        id: 'rerank-targeted',
        label: 'Rerank English/literal harder, keep thematic conservative',
        override: {
            typeOverrides: {
                english_meaning: {
                    rerankTopK: 24,
                    rerankBlendWeight: 0.25,
                    rerankMeaningPhraseWeight: 1.0,
                    rerankLiteralPhraseWeight: 0.75,
                    rerankCoverageWeight: 0.7,
                    rerankWeightedJaccardWeight: 0.5,
                    rerankFocusedCoverageWeight: 0.35,
                    rerankAllFocusedTokensBoost: 0.4,
                    rerankBigramWeight: 0.5,
                    rerankTrigramWeight: 0.25
                },
                thematic: {
                    rerankTopK: 18,
                    rerankBlendWeight: 0.1,
                    rerankMeaningPhraseWeight: 0.6,
                    rerankLiteralPhraseWeight: 0.4,
                    rerankCoverageWeight: 0.35,
                    rerankWeightedJaccardWeight: 0.25,
                    rerankFocusedCoverageWeight: 0.15,
                    rerankAllFocusedTokensBoost: 0.1,
                    rerankBigramWeight: 0.2,
                    rerankTrigramWeight: 0.1
                },
                literal: {
                    rerankTopK: 20,
                    rerankBlendWeight: 0.2,
                    rerankMeaningPhraseWeight: 0.7,
                    rerankLiteralPhraseWeight: 1.0,
                    rerankCoverageWeight: 0.6,
                    rerankWeightedJaccardWeight: 0.35,
                    rerankFocusedCoverageWeight: 0.25,
                    rerankAllFocusedTokensBoost: 0.25,
                    rerankBigramWeight: 0.55,
                    rerankTrigramWeight: 0.2
                }
            }
        }
    }
};

const DEFAULT_RERANKER_PROFILES = [
    'current',
    'rerank-light',
    'rerank-medium',
    'rerank-targeted'
];

function resolveRerankerProfiles(ids = DEFAULT_RERANKER_PROFILES) {
    return ids.map(id => {
        const profile = RERANKER_PROFILES[id];
        if (!profile) {
            throw new Error(`Unknown reranker profile "${id}"`);
        }
        return profile;
    });
}

module.exports = {
    DEFAULT_RERANKER_PROFILES,
    RERANKER_PROFILES,
    resolveRerankerProfiles
};

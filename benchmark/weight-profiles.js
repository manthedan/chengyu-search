const WEIGHT_PROFILES = {
    current: {
        id: 'current',
        label: 'Current promoted weights',
        override: null
    },
    'balanced-plus': {
        id: 'balanced-plus',
        label: 'Slightly more embedding weight across semantic-routed types',
        override: {
            typeOverrides: {
                english_meaning: {
                    embeddingWeight: 0.75,
                    tokenWeight: 0.25
                },
                thematic: {
                    embeddingWeight: 0.8,
                    tokenWeight: 0.2
                },
                literal: {
                    embeddingWeight: 0.35,
                    tokenWeight: 0.65
                }
            }
        }
    },
    'semantic-heavy': {
        id: 'semantic-heavy',
        label: 'Push embeddings harder on semantic-routed traffic',
        override: {
            typeOverrides: {
                english_meaning: {
                    embeddingWeight: 0.8,
                    tokenWeight: 0.2
                },
                thematic: {
                    embeddingWeight: 0.85,
                    tokenWeight: 0.15
                },
                literal: {
                    embeddingWeight: 0.4,
                    tokenWeight: 0.6
                }
            }
        }
    },
    'literal-token-heavy': {
        id: 'literal-token-heavy',
        label: 'Keep literal queries more lexical while nudging English/thematic up',
        override: {
            typeOverrides: {
                english_meaning: {
                    embeddingWeight: 0.75,
                    tokenWeight: 0.25
                },
                thematic: {
                    embeddingWeight: 0.8,
                    tokenWeight: 0.2
                },
                literal: {
                    embeddingWeight: 0.25,
                    tokenWeight: 0.75
                }
            }
        }
    },
    'thematic-token-rescue': {
        id: 'thematic-token-rescue',
        label: 'Reduce thematic embedding reliance, keep literal modestly embedding-aware',
        override: {
            typeOverrides: {
                english_meaning: {
                    embeddingWeight: 0.7,
                    tokenWeight: 0.3
                },
                thematic: {
                    embeddingWeight: 0.65,
                    tokenWeight: 0.35
                },
                literal: {
                    embeddingWeight: 0.35,
                    tokenWeight: 0.65
                }
            }
        }
    },
    'english-token-rescue': {
        id: 'english-token-rescue',
        label: 'Reduce embedding weight for english meaning, keep others modestly high',
        override: {
            typeOverrides: {
                english_meaning: {
                    embeddingWeight: 0.6,
                    tokenWeight: 0.4
                },
                thematic: {
                    embeddingWeight: 0.8,
                    tokenWeight: 0.2
                },
                literal: {
                    embeddingWeight: 0.35,
                    tokenWeight: 0.65
                }
            }
        }
    }
};

const DEFAULT_WEIGHT_PROFILES = [
    'current',
    'balanced-plus',
    'semantic-heavy',
    'literal-token-heavy',
    'thematic-token-rescue',
    'english-token-rescue'
];

function listWeightProfiles() {
    return DEFAULT_WEIGHT_PROFILES.map(id => WEIGHT_PROFILES[id]);
}

function resolveWeightProfiles(ids = DEFAULT_WEIGHT_PROFILES) {
    return ids.map(id => {
        const profile = WEIGHT_PROFILES[id];
        if (!profile) {
            throw new Error(`Unknown weight profile "${id}"`);
        }
        return profile;
    });
}

module.exports = {
    DEFAULT_WEIGHT_PROFILES,
    WEIGHT_PROFILES,
    listWeightProfiles,
    resolveWeightProfiles
};

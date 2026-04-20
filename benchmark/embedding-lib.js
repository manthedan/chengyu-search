const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const CHENGYU = require('../chengyuData.js');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_VARIANT_DIR = path.join(REPO_ROOT, 'embeddings', 'variants');
const DEFAULT_BASELINE_FILE = path.join(REPO_ROOT, 'embeddings-local.json');
const DEFAULT_BASELINE_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

const EMBEDDING_MODELS = {
    minilm: {
        key: 'minilm',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        label: 'MiniLM L6 v2'
    },
    'bge-small': {
        key: 'bge-small',
        modelId: 'Xenova/bge-small-en-v1.5',
        label: 'BGE small EN v1.5'
    },
    'bge-base': {
        key: 'bge-base',
        modelId: 'Xenova/bge-base-en-v1.5',
        label: 'BGE base EN v1.5'
    },
    'gte-small': {
        key: 'gte-small',
        modelId: 'Xenova/gte-small',
        label: 'GTE small'
    }
};

const EMBEDDING_TEMPLATES = {
    'meaning-only': {
        key: 'meaning-only',
        label: 'Meaning only',
        build: (entry) => entry.meaning || ''
    },
    'meaning-literal': {
        key: 'meaning-literal',
        label: 'Meaning + literal',
        build: (entry) => `${entry.meaning || ''}. Literally: ${entry.literal || ''}`.trim()
    },
    'meaning-literal-tags': {
        key: 'meaning-literal-tags',
        label: 'Meaning + literal + tags',
        build: (entry) => `${entry.meaning || ''}. Literally: ${entry.literal || ''}. Topics: ${(entry.tags || []).join(', ')}`.trim()
    },
    'english-dense': {
        key: 'english-dense',
        label: 'English dense',
        build: (entry) => `${entry.meaning || ''}. ${entry.literal || ''}. ${entry.usage || ''}. Topics: ${(entry.tags || []).join(', ')}`.trim()
    },
    rich: {
        key: 'rich',
        label: 'Rich mixed context',
        build: (entry) => `Chinese idiom: ${entry.chengyu}. Pinyin: ${entry.pinyin || ''}. Meaning: ${entry.meaning || ''}. Literal: ${entry.literal || ''}. Usage: ${entry.usage || ''}. Tags: ${(entry.tags || []).join(', ')}`.trim()
    },
    'tags-meaning': {
        key: 'tags-meaning',
        label: 'Tags + meaning',
        build: (entry) => `${(entry.tags || []).join(', ')}. ${entry.meaning || ''}`.trim()
    }
};

const EMBEDDING_PRESETS = {
    quick: [
        'current',
        'minilm:meaning-literal',
        'minilm:english-dense',
        'bge-small:english-dense',
        'gte-small:english-dense'
    ],
    broad: [
        'current',
        'minilm:meaning-only',
        'minilm:meaning-literal',
        'minilm:meaning-literal-tags',
        'minilm:english-dense',
        'bge-small:meaning-literal',
        'bge-small:english-dense',
        'bge-base:english-dense',
        'gte-small:english-dense',
        'gte-small:meaning-literal-tags'
    ]
};

const embedderCache = new Map();

function toRepoRelative(filePath) {
    return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function getVariantId(modelKey, templateKey) {
    return `${modelKey}__${templateKey}`;
}

function parseVariantSpec(spec) {
    const value = String(spec || '').trim();
    if (!value) {
        throw new Error('Variant spec cannot be empty');
    }

    if (value === 'current' || value === 'baseline') {
        return { type: 'current' };
    }

    const normalized = value.replace('/', ':').replace('__', ':');
    const [modelKey, templateKey] = normalized.split(':');
    if (!modelKey || !templateKey) {
        throw new Error(`Invalid variant spec "${value}". Use current or <model>:<template>.`);
    }

    return {
        type: 'generated',
        modelKey,
        templateKey
    };
}

function buildVariant(spec) {
    const parsed = typeof spec === 'string' ? parseVariantSpec(spec) : spec;

    if (parsed.type === 'current') {
        return {
            type: 'current',
            id: 'current',
            label: 'Current baseline embeddings',
            modelKey: 'minilm',
            modelId: DEFAULT_BASELINE_MODEL_ID,
            templateKey: 'current',
            filePath: DEFAULT_BASELINE_FILE,
            relativeFilePath: toRepoRelative(DEFAULT_BASELINE_FILE)
        };
    }

    const model = EMBEDDING_MODELS[parsed.modelKey];
    if (!model) {
        throw new Error(`Unknown embedding model "${parsed.modelKey}"`);
    }

    const template = EMBEDDING_TEMPLATES[parsed.templateKey];
    if (!template) {
        throw new Error(`Unknown embedding template "${parsed.templateKey}"`);
    }

    const id = getVariantId(model.key, template.key);
    const filePath = path.join(DEFAULT_VARIANT_DIR, `${id}.json`);

    return {
        type: 'generated',
        id,
        label: `${model.key} + ${template.key}`,
        modelKey: model.key,
        modelId: model.modelId,
        modelLabel: model.label,
        templateKey: template.key,
        templateLabel: template.label,
        filePath,
        relativeFilePath: toRepoRelative(filePath)
    };
}

function resolveVariants({ variants, preset = 'quick', includeCurrent = true } = {}) {
    const specs = Array.isArray(variants) && variants.length > 0
        ? variants
        : EMBEDDING_PRESETS[preset];

    if (!specs) {
        throw new Error(`Unknown preset "${preset}"`);
    }

    let resolved = specs.map(buildVariant);
    if (!includeCurrent) {
        resolved = resolved.filter(variant => variant.type !== 'current');
    }
    return resolved;
}

function variantExists(variant) {
    return fs.existsSync(variant.filePath);
}

function buildTemplateText(templateKey, entry) {
    const template = EMBEDDING_TEMPLATES[templateKey];
    if (!template) {
        throw new Error(`Unknown embedding template "${templateKey}"`);
    }

    const text = template.build(entry);
    return text && text.trim() ? text.trim() : (entry.meaning || entry.literal || entry.chengyu || '');
}

async function getEmbedder(modelId) {
    if (!embedderCache.has(modelId)) {
        embedderCache.set(modelId, (async () => {
            const { pipeline } = await import('@xenova/transformers');
            return pipeline('feature-extraction', modelId);
        })());
    }
    return embedderCache.get(modelId);
}

async function generateVariantEmbeddings(variant, {
    force = false,
    onProgress = null,
    log = null
} = {}) {
    if (variant.type === 'current') {
        if (!variantExists(variant)) {
            throw new Error(`Baseline embeddings file not found: ${variant.filePath}`);
        }
        return {
            variant,
            generated: false,
            skipped: true,
            filePath: variant.filePath
        };
    }

    if (!force && variantExists(variant)) {
        return {
            variant,
            generated: false,
            skipped: true,
            filePath: variant.filePath
        };
    }

    await fsp.mkdir(path.dirname(variant.filePath), { recursive: true });
    if (typeof log === 'function') {
        log(`Generating ${variant.id} → ${variant.relativeFilePath}`);
    }

    const embedder = await getEmbedder(variant.modelId);
    const embeddings = [];
    const startedAt = Date.now();

    for (let i = 0; i < CHENGYU.length; i++) {
        const entry = CHENGYU[i];
        const text = buildTemplateText(variant.templateKey, entry);
        const output = await embedder(text, {
            pooling: 'mean',
            normalize: true
        });

        embeddings.push({
            chengyu: entry.chengyu,
            embedding: Array.from(output.data)
        });

        if (typeof onProgress === 'function') {
            onProgress({
                variant,
                completed: i + 1,
                total: CHENGYU.length,
                elapsedMs: Date.now() - startedAt
            });
        }
    }

    const metadata = {
        version: 1,
        model: variant.modelId,
        modelKey: variant.modelKey,
        template: variant.templateKey,
        dimensions: embeddings[0] ? embeddings[0].embedding.length : 0,
        generatedAt: new Date().toISOString(),
        entryCount: embeddings.length,
        embeddings
    };

    await fsp.writeFile(variant.filePath, JSON.stringify(metadata));

    return {
        variant,
        generated: true,
        skipped: false,
        filePath: variant.filePath,
        dimensions: metadata.dimensions,
        entryCount: metadata.entryCount,
        generatedAt: metadata.generatedAt,
        durationMs: Date.now() - startedAt
    };
}

function getVariantEnv(variant) {
    return {
        EMBEDDINGS_FILE: variant.relativeFilePath,
        EMBEDDING_MODEL_ID: variant.modelId,
        QUIET_LOGS: '1'
    };
}

module.exports = {
    DEFAULT_BASELINE_FILE,
    EMBEDDING_MODELS,
    EMBEDDING_PRESETS,
    EMBEDDING_TEMPLATES,
    buildTemplateText,
    buildVariant,
    generateVariantEmbeddings,
    getVariantEnv,
    getVariantId,
    parseVariantSpec,
    resolveVariants,
    toRepoRelative,
    variantExists
};

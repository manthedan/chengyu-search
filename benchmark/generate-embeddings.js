#!/usr/bin/env node
const {
    parseArgs,
    parseList
} = require('./lib.js');
const {
    EMBEDDING_MODELS,
    EMBEDDING_PRESETS,
    EMBEDDING_TEMPLATES,
    generateVariantEmbeddings,
    resolveVariants
} = require('./embedding-lib.js');

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function listCatalog() {
    console.log('Models:');
    Object.values(EMBEDDING_MODELS).forEach(model => {
        console.log(`  ${model.key.padEnd(12)} ${model.modelId}`);
    });

    console.log('\nTemplates:');
    Object.values(EMBEDDING_TEMPLATES).forEach(template => {
        console.log(`  ${template.key.padEnd(20)} ${template.label}`);
    });

    console.log('\nPresets:');
    Object.entries(EMBEDDING_PRESETS).forEach(([preset, specs]) => {
        console.log(`  ${preset.padEnd(12)} ${specs.join(', ')}`);
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.list) {
        listCatalog();
        return;
    }

    const variants = parseList(args.variants, null);
    const preset = args.preset || 'quick';
    const includeCurrent = !Boolean(args['no-current']);
    const force = Boolean(args.force);

    const resolvedVariants = resolveVariants({
        variants,
        preset,
        includeCurrent
    });

    const results = [];
    for (const variant of resolvedVariants) {
        let lastLogged = 0;
        const result = await generateVariantEmbeddings(variant, {
            force,
            log: message => console.error(message),
            onProgress: variant.type === 'generated'
                ? ({ completed, total, elapsedMs }) => {
                    if (completed === total || completed - lastLogged >= 100) {
                        lastLogged = completed;
                        console.error(`  ${variant.id}: ${completed}/${total} (${Math.round((completed / total) * 100)}%) — ${formatDuration(elapsedMs)}`);
                    }
                }
                : null
        });
        results.push({
            variant: variant.id,
            model: variant.modelId,
            template: variant.templateKey,
            file: variant.relativeFilePath,
            generated: result.generated,
            skipped: result.skipped,
            dimensions: result.dimensions || null,
            entryCount: result.entryCount || null,
            generatedAt: result.generatedAt || null,
            durationMs: result.durationMs || 0
        });
    }

    console.log(JSON.stringify({
        action: 'generate-embeddings',
        preset,
        variants: results,
        timestamp: new Date().toISOString()
    }));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

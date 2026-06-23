process.env.QUIET_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    getQueryVariants,
    semanticSearchOnly
} = require('../src/search/search-logic.js');
const {
    buildStableChengyuId,
    withStableChengyuIds
} = require('../src/data/chengyu-identity.js');
const {
    buildEmbeddingCorpusHash,
    validateEmbeddingArtifact
} = require('../src/embeddings/embedding-validation.js');

function makeCorpus() {
    return withStableChengyuIds([
        {
            chengyu: '甲乙丙丁',
            pinyin: 'jia3 yi3 bing3 ding1',
            literal: 'alpha literal',
            meaning: 'first controlled entry',
            example: 'example one',
            tags: ['alpha'],
            formality: 'formal'
        },
        {
            chengyu: '子丑寅卯',
            pinyin: 'zi3 chou3 yin2 mao3',
            literal: 'beta literal',
            meaning: 'second controlled entry',
            example: 'example two',
            tags: ['beta'],
            formality: 'formal'
        }
    ]);
}

function makeArtifact(database, overrides = {}) {
    const embeddings = database.map((entry, index) => ({
        id: entry.id,
        chengyu: entry.chengyu,
        embedding: index === 0 ? [1, 0] : [0, 1]
    }));

    return {
        version: 1,
        model: 'test-model',
        template: 'meaning-literal-tags',
        pooling: 'mean',
        normalize: true,
        dimensions: 2,
        corpusHash: buildEmbeddingCorpusHash(database, 'meaning-literal-tags'),
        entryCount: embeddings.length,
        embeddings,
        ...overrides
    };
}

async function startServerWithArtifact(artifact) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chengyu-embedding-fixture-'));
    const artifactPath = path.join(fixtureDir, 'embeddings.json');
    fs.writeFileSync(artifactPath, JSON.stringify(artifact));

    const child = spawn(process.execPath, ['-e', `
        const { startServer } = require('./api-server.js');
        startServer({ port: 0 }).then(server => {
            console.log('PORT:' + server.address().port);
        }).catch(error => {
            console.error(error && error.stack || error);
            process.exit(1);
        });
    `], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            QUIET_LOGS: '1',
            EMBEDDINGS_FILE: artifactPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });

    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out starting fixture server: ${stderr}`)), 10000);
        child.stdout.on('data', chunk => {
            const match = chunk.toString().match(/PORT:(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            reject(new Error(`Fixture server exited with ${code}: ${stderr}`));
        });
    });

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
            if (child.exitCode != null) return;
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
        }
    };
}

describe('stable Chengyu embedding identity', () => {
    it('creates unique stable IDs for duplicate display headwords without changing display text', () => {
        const database = withStableChengyuIds(require('../chengyuData.js'));
        const duplicateRows = database.filter(entry => entry.chengyu === '难兄难弟');

        assert.equal(duplicateRows.length, 2, 'fixture should include duplicate display headwords');
        assert.equal(new Set(duplicateRows.map(entry => entry.id)).size, 2, 'duplicate display rows need unique public IDs');
        assert.ok(duplicateRows.every(entry => entry.chengyu === '难兄难弟'), 'display headword must be preserved');
        assert.ok(duplicateRows.every(entry => buildStableChengyuId(entry) === entry.id), 'stable ID should be deterministic from entry content');
    });

    it('validates and returns an ID-keyed embedding map regardless of artifact entry order', () => {
        const database = makeCorpus();
        const artifact = makeArtifact(database, {
            embeddings: makeArtifact(database).embeddings.slice().reverse()
        });

        const result = validateEmbeddingArtifact(artifact, database);

        assert.equal(result.ok, true, result.diagnostics.join('\n'));
        assert.deepEqual(result.embeddingsById.get(database[0].id), [1, 0]);
        assert.deepEqual(result.embeddingsById.get(database[1].id), [0, 1]);
    });

    it('keeps raw semantic query separate from expanded lexical query', async () => {
        const variants = getQueryVariants('doing something useless');
        assert.equal(variants.semanticQuery, 'doing something useless');
        assert.match(variants.lexicalQuery, /futile/);

        const database = makeCorpus();
        const validation = validateEmbeddingArtifact(makeArtifact(database), database);
        let embeddedQuery = null;

        await semanticSearchOnly(
            'doing something useless',
            database,
            validation.embeddingsById,
            {
                embeddingWeight: 1,
                tokenWeight: 0,
                semanticTopK: 2,
                rerankTopK: 0
            },
            {
                generateQueryEmbedding: async query => {
                    embeddedQuery = query;
                    return [1, 0];
                }
            }
        );

        assert.equal(embeddedQuery, 'doing something useless');
    });

    it('reranks id-less corpora using candidate item features for duplicate headwords', async () => {
        const database = [
            { chengyu: '甲甲甲甲', meaning: 'unrelated gamma', literal: '', example: '', tags: [] },
            { chengyu: '甲甲甲甲', meaning: 'alpha beta target', literal: '', example: '', tags: [] }
        ];

        const results = await semanticSearchOnly(
            'alpha beta',
            database,
            null,
            {
                semanticTopK: 2,
                rerankTopK: 2,
                rerankBlendWeight: 1,
                rerankCoverageWeight: 1
            }
        );

        assert.equal(results[0].item.meaning, 'alpha beta target');
        assert.ok(results[0].score > 0, 'reranker should assign a positive score using the candidate item, not the first duplicate headword');
    });

    it('can rerank top semantic candidates with an injected cross-encoder scorer', async () => {
        const database = makeCorpus();
        let rerankQuery = null;

        const results = await semanticSearchOnly(
            'doing something useless',
            database,
            null,
            {
                semanticTopK: 2,
                rerankTopK: 0,
                crossEncoderTopK: 2,
                crossEncoderBlendWeight: 1
            },
            {
                scoreCrossEncoder: async (query, candidates) => {
                    rerankQuery = query;
                    return candidates.map(candidate => (
                        candidate.item.id === database[1].id ? 10 : 0
                    ));
                }
            }
        );

        assert.equal(rerankQuery, 'doing something useless');
        assert.equal(results[0].item.id, database[1].id);
        assert.equal(results[0].score, 1);
    });

    it('keeps unscored candidates behind the cross-encoder rerank window', async () => {
        const database = makeCorpus();
        const artifact = makeArtifact(database, {
            embeddings: [
                { ...makeArtifact(database).embeddings[0], embedding: [1, 0] },
                { ...makeArtifact(database).embeddings[1], embedding: [0.9, Math.sqrt(0.19)] }
            ]
        });
        const validation = validateEmbeddingArtifact(artifact, database);

        const results = await semanticSearchOnly(
            'controlled query',
            database,
            validation.embeddingsById,
            {
                embeddingWeight: 1,
                tokenWeight: 0,
                semanticTopK: 2,
                rerankTopK: 0,
                crossEncoderTopK: 1,
                crossEncoderBlendWeight: 1
            },
            {
                generateQueryEmbedding: async () => [1, 0],
                scoreCrossEncoder: async () => [0]
            }
        );

        assert.equal(results[0].item.id, database[0].id);
        assert.ok(results[0].score > results[1].score);
    });

    it('semantic search looks up vectors by stable ID, not artifact array position', async () => {
        const database = makeCorpus();
        const artifact = makeArtifact(database, {
            embeddings: makeArtifact(database).embeddings.slice().reverse()
        });
        const validation = validateEmbeddingArtifact(artifact, database);

        const results = await semanticSearchOnly(
            'controlled query',
            database,
            validation.embeddingsById,
            {
                embeddingWeight: 1,
                tokenWeight: 0,
                semanticTopK: 2,
                rerankTopK: 0
            },
            {
                generateQueryEmbedding: async () => [1, 0]
            }
        );

        assert.equal(results[0].item.id, database[0].id);
        assert.equal(results[0].chengyu, database[0].chengyu);
    });

    it('rejects duplicate, missing, extra, malformed, non-finite, wrong-dimension, and count-mismatched artifacts', () => {
        const database = makeCorpus();
        const base = makeArtifact(database);

        const cases = [
            {
                name: 'duplicate database IDs',
                database: [{ ...database[0] }, { ...database[1], id: database[0].id }],
                artifact: base,
                match: /duplicate database embedding id/i
            },
            {
                name: 'duplicate artifact IDs',
                artifact: {
                    ...base,
                    embeddings: [
                        base.embeddings[0],
                        { ...base.embeddings[1], id: base.embeddings[0].id }
                    ]
                },
                match: /duplicate artifact embedding id/i
            },
            {
                name: 'missing artifact ID',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], id: undefined }, base.embeddings[1]]
                },
                match: /missing stable id/i
            },
            {
                name: 'legacy no-ID artifact',
                artifact: {
                    ...base,
                    embeddings: base.embeddings.map(({ id, ...entry }) => entry)
                },
                match: /missing stable id/i
            },
            {
                name: 'missing artifact row',
                artifact: {
                    ...base,
                    embeddings: [base.embeddings[0]],
                    entryCount: 1
                },
                match: new RegExp(`missing.*${database[1].id}`, 'i')
            },
            {
                name: 'extra artifact ID',
                artifact: {
                    ...base,
                    embeddings: [
                        ...base.embeddings,
                        { id: 'chengyu_extra_entry', chengyu: '额外', embedding: [0, 1] }
                    ],
                    entryCount: 3
                },
                match: /extra.*chengyu_extra_entry/i
            },
            {
                name: 'count-equal missing plus extra ID',
                artifact: {
                    ...base,
                    embeddings: [
                        base.embeddings[0],
                        { id: 'chengyu_extra_entry', chengyu: '额外', embedding: [0, 1] }
                    ]
                },
                match: /missing.*extra/i
            },
            {
                name: 'short vector',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [1] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*dimension.*1`, 'i')
            },
            {
                name: 'long vector',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [1, 0, 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*dimension.*3`, 'i')
            },
            {
                name: 'NaN vector value',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [Number.NaN, 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding\\[0\\].*finite`, 'i')
            },
            {
                name: 'Infinity vector value',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [Infinity, 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding\\[0\\].*finite`, 'i')
            },
            {
                name: 'negative Infinity vector value',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [-Infinity, 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding\\[0\\].*finite`, 'i')
            },
            {
                name: 'missing vector',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: undefined }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding.*array`, 'i')
            },
            {
                name: 'non-array vector',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: 'not a vector' }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding.*array`, 'i')
            },
            {
                name: 'nested vector value',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: [[1], 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding\\[0\\].*number`, 'i')
            },
            {
                name: 'string vector value',
                artifact: {
                    ...base,
                    embeddings: [{ ...base.embeddings[0], embedding: ['1', 0] }, base.embeddings[1]]
                },
                match: new RegExp(`${database[0].id}.*embedding\\[0\\].*number`, 'i')
            },
            {
                name: 'entryCount mismatch',
                artifact: {
                    ...base,
                    entryCount: 99
                },
                match: /entryCount.*99.*2/i
            }
        ];

        for (const testCase of cases) {
            const result = validateEmbeddingArtifact(testCase.artifact, testCase.database || database);
            assert.equal(result.ok, false, `${testCase.name} should disable semantic embeddings`);
            assert.match(result.diagnostics.join('\n'), testCase.match, testCase.name);
        }
    });

    it('rejects embedding-space metadata mismatches as fatal', () => {
        const database = makeCorpus();
        const base = makeArtifact(database);
        const expected = {
            expectedModel: 'test-model',
            expectedPooling: 'mean',
            expectedNormalize: true,
            expectedTemplate: 'meaning-literal-tags',
            expectedDimensions: 2,
            expectedCorpusHash: buildEmbeddingCorpusHash(database, 'meaning-literal-tags'),
            allowLegacyIds: false
        };

        assert.equal(validateEmbeddingArtifact(base, database, expected).ok, true);

        const cases = [
            {
                name: 'model',
                artifact: { ...base, model: 'other-model' },
                match: /model.*other-model.*test-model/i
            },
            {
                name: 'pooling',
                artifact: { ...base, pooling: 'cls' },
                match: /pooling.*cls.*mean/i
            },
            {
                name: 'normalization',
                artifact: { ...base, normalize: false },
                match: /normalize.*false.*true/i
            },
            {
                name: 'template',
                artifact: { ...base, template: 'meaning-only' },
                match: /template.*meaning-only.*meaning-literal-tags/i
            },
            {
                name: 'dimensions',
                artifact: { ...base, dimensions: 3 },
                match: /dimensions.*3.*2/i
            },
            {
                name: 'corpus hash',
                artifact: { ...base, corpusHash: 'wrong-hash' },
                match: /corpus hash.*wrong-hash/i
            },
            {
                name: 'missing required metadata',
                artifact: { ...base, corpusHash: undefined },
                match: /missing required corpus hash/i
            }
        ];

        for (const testCase of cases) {
            const result = validateEmbeddingArtifact(testCase.artifact, database, expected);
            assert.equal(result.ok, false, `${testCase.name} should disable semantic embeddings`);
            assert.match(result.diagnostics.join('\n'), testCase.match, testCase.name);
        }
    });

    it('validates the checked-in embedding artifact with concrete stable IDs', function() {
        const database = withStableChengyuIds(require('../chengyuData.js'));
        const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'embeddings-local.json'), 'utf8'));

        const expectedCorpusHash = buildEmbeddingCorpusHash(database, 'rich');
        if (artifact.corpusHash !== expectedCorpusHash) return;

        const result = validateEmbeddingArtifact(artifact, database, {
            expectedModel: 'Xenova/all-MiniLM-L6-v2',
            expectedPooling: 'mean',
            expectedNormalize: true,
            expectedTemplate: 'rich',
            expectedDimensions: 384,
            expectedCorpusHash,
            allowLegacyIds: false
        });

        assert.equal(result.ok, true, result.diagnostics.join('\n'));
        assert.equal(artifact.embeddings[0].id, database[0].id);
        assert.equal(result.embeddingsById.size, database.length);
        assert.deepEqual(result.embeddingsById.get(database[0].id), artifact.embeddings[0].embedding);
    });

    it('keeps the API running but disables semantic embeddings for embedding model mismatches', async () => {
        const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'embeddings-local.json'), 'utf8'));
        const mismatchedArtifact = {
            ...artifact,
            model: 'Xenova/different-embedding-space'
        };

        const server = await startServerWithArtifact(mismatchedArtifact);
        try {
            const health = await (await fetch(`${server.baseUrl}/api/health`)).json();
            assert.equal(health.status, 'ok');
            assert.equal(health.database, true);
            assert.equal(health.embeddings, false);
            assert.match(health.embeddingValidationDiagnostics.join('\n'), /model.*different-embedding-space.*all-MiniLM-L6-v2/i);

            const semanticResponse = await fetch(`${server.baseUrl}/api/search/semantic`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'opportunity' })
            });
            const semantic = await semanticResponse.json();
            assert.equal(semanticResponse.status, 503);
            assert.equal(semantic.fallbackToHybrid, true);
        } finally {
            await server.close();
        }
    });

    it('keeps the API running but disables semantic embeddings for invalid artifacts', async () => {
        const database = withStableChengyuIds(require('../chengyuData.js'));
        const invalidArtifact = {
            version: 1,
            model: 'test-model',
            template: 'test-template',
            dimensions: 2,
            entryCount: 2,
            embeddings: [
                { id: database[0].id, chengyu: database[0].chengyu, embedding: [1, 0] },
                { id: database[0].id, chengyu: database[1].chengyu, embedding: [0, 1] }
            ]
        };

        const server = await startServerWithArtifact(invalidArtifact);
        try {
            const health = await (await fetch(`${server.baseUrl}/api/health`)).json();
            assert.equal(health.status, 'ok');
            assert.equal(health.database, true);
            assert.equal(health.embeddings, false);

            const semanticResponse = await fetch(`${server.baseUrl}/api/search/semantic`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'opportunity' })
            });
            const semantic = await semanticResponse.json();
            assert.equal(semanticResponse.status, 503);
            assert.equal(semantic.fallbackToHybrid, true);

            const keywordResponse = await fetch(`${server.baseUrl}/api/search/keyword`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '画蛇添足' })
            });
            const keyword = await keywordResponse.json();
            assert.equal(keywordResponse.status, 200);
            assert.ok(keyword.results.length > 0);
        } finally {
            await server.close();
        }
    });
});

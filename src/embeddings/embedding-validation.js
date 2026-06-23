/** @ts-check */

const crypto = require('crypto');

/**
 * @typedef {import('../search/types').ChengyuEntry} ChengyuEntry
 * @typedef {ChengyuEntry & { embedding?: number[], embeddingId?: string, publicId?: string, text?: string }} EmbeddingEntry
 * @typedef {{ id: string, chengyu?: string, embedding: number[] | Float32Array, text?: string }} EmbeddingArtifactRow
 * @typedef {{ version?: number, model?: string, modelKey?: string, template?: string, pooling?: string, normalize?: boolean, dimensions?: number, corpusHash?: string, generatedAt?: string, entryCount?: number, embeddings?: EmbeddingArtifactRow[] }} EmbeddingArtifactObject
 * @typedef {EmbeddingArtifactObject | EmbeddingArtifactRow[]} EmbeddingArtifact
 * @typedef {{ expectedModel?: string, expectedPooling?: string, expectedNormalize?: boolean, expectedTemplate?: string, expectedCorpusHash?: string, expectedDimensions?: number, allowLegacyIds?: boolean }} ValidationOptions
 * @typedef {{ ok: boolean, diagnostics: string[], embeddingsById: Map<string, number[] | Float32Array>, dimensions?: number | null, entryCount?: number | undefined }} ValidationResult
 * @typedef {{ chengyu?: string, pinyin?: string, literal?: string, meaning?: string, example?: string, tags?: readonly string[], formality?: string }} TemplateEntry
 */

/** @type {Record<string, (entry: TemplateEntry) => string>} */
const EMBEDDING_TEMPLATES = {
  'meaning-only': entry => entry.meaning || '',
  'meaning-literal': entry => `${entry.meaning || ''}. Literally: ${entry.literal || ''}`.trim(),
  'meaning-literal-tags': entry => `${entry.meaning || ''}. Literally: ${entry.literal || ''}. Topics: ${(entry.tags || []).join(', ')}`.trim(),
  'english-dense': entry => `${entry.meaning || ''}. ${entry.literal || ''}. Topics: ${(entry.tags || []).join(', ')}`.trim(),
  rich: entry => `Chinese idiom: ${entry.chengyu}. Pinyin: ${entry.pinyin || ''}. Meaning: ${entry.meaning || ''}. Literal: ${entry.literal || ''}. Tags: ${(entry.tags || []).join(', ')}`.trim(),
  'tags-meaning': entry => `${(entry.tags || []).join(', ')}. ${entry.meaning || ''}`.trim(),
  example: entry => `${entry.meaning || ''}. ${entry.example || ''}`.trim(),
  'meaning-boosted': entry => `${entry.meaning || ''}. ${entry.meaning || ''}. Literally: ${entry.literal || ''}`.trim(),
  'literal-first': entry => `${entry.literal || ''}. Meaning: ${entry.meaning || ''}`.trim(),
  'literal-only': entry => entry.literal || entry.meaning || '',
  'query-style': entry => `${entry.meaning || ''} ${entry.literal || ''} ${(entry.tags || []).join(' ')}`.trim()
};

/**
 * @param {unknown} artifact
 * @returns {EmbeddingArtifactRow[] | null}
 */
function getArtifactEntries(artifact) {
  if (Array.isArray(artifact)) {
    return /** @type {EmbeddingArtifactRow[]} */ (artifact);
  }
  if (artifact && typeof artifact === 'object') {
    const objectArtifact = /** @type {{ embeddings?: unknown }} */ (artifact);
    if (Array.isArray(objectArtifact.embeddings)) {
      return /** @type {EmbeddingArtifactRow[]} */ (objectArtifact.embeddings);
    }
  }
  return null;
}

/**
 * @param {unknown} artifact
 * @param {EmbeddingArtifactRow[]} embeddingEntries
 * @returns {number | undefined}
 */
function getArtifactEntryCount(artifact, embeddingEntries) {
  if (Array.isArray(artifact)) {
    return embeddingEntries.length;
  }
  if (artifact && typeof artifact === 'object') {
    return /** @type {{ entryCount?: number }} */ (artifact).entryCount;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function getEmbeddingId(value) {
  if (!value || typeof value !== 'object') return undefined;
  const entry = /** @type {{ id?: unknown, embeddingId?: unknown, publicId?: unknown }} */ (value);
  const id = entry.id || entry.embeddingId || entry.publicId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isConcreteId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function normalizeTemplateValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeTemplateValue);
  }
  if (value == null) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ');
}

/**
 * @param {string} templateKey
 * @param {TemplateEntry} [entry]
 * @returns {string}
 */
function buildEmbeddingTemplateText(templateKey, entry = {}) {
  const template = EMBEDDING_TEMPLATES[templateKey];
  if (!template) {
    throw new Error(`Unknown embedding template "${templateKey}"`);
  }

  const normalizedEntry = {
    ...entry,
    chengyu: normalizeTemplateValue(entry.chengyu),
    pinyin: normalizeTemplateValue(entry.pinyin),
    literal: normalizeTemplateValue(entry.literal),
    meaning: normalizeTemplateValue(entry.meaning),
    example: normalizeTemplateValue(entry.example),
    tags: normalizeTemplateValue(entry.tags || []),
    formality: normalizeTemplateValue(entry.formality)
  };

  const text = template(normalizedEntry);
  return text && text.trim() ? text.trim() : (normalizedEntry.meaning || normalizedEntry.literal || normalizedEntry.chengyu || '');
}

/**
 * @param {EmbeddingEntry[]} database
 * @param {string} templateKey
 * @returns {string}
 */
function buildEmbeddingCorpusHash(database = [], templateKey) {
  if (!Array.isArray(database)) {
    throw new Error('Database corpus must be an array');
  }

  const rows = database.map((entry, index) => {
    const id = getEmbeddingId(entry);
    if (!isConcreteId(id)) {
      throw new Error(`Database entry at index ${index} has missing stable embedding id`);
    }
    return {
      id,
      chengyu: normalizeTemplateValue(entry.chengyu),
      text: buildEmbeddingTemplateText(templateKey, entry)
    };
  });

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ version: 1, template: templateKey, rows }))
    .digest('hex');
}

/**
 * @param {{ database?: EmbeddingEntry[], embeddings?: EmbeddingEntry[], model?: string, modelKey?: string, template?: string, pooling?: string, normalize?: boolean, generatedAt?: string, version?: number, includeText?: boolean }} [options]
 * @returns {EmbeddingArtifactObject}
 */
function buildEmbeddingArtifact({
  database = [],
  embeddings = [],
  model,
  modelKey,
  template,
  pooling = 'mean',
  normalize = true,
  generatedAt = new Date().toISOString(),
  version = 1,
  includeText = false
} = {}) {
  if (!model) throw new Error('Embedding artifact model is required');
  if (!template) throw new Error('Embedding artifact template is required');
  if (!Array.isArray(database) || !Array.isArray(embeddings) || database.length !== embeddings.length) {
    throw new Error(`Embedding artifact requires matching database and embedding counts (${database.length} !== ${embeddings.length})`);
  }

  const rows = embeddings.map((entry, index) => {
    const databaseEntry = database[index];
    if (!databaseEntry) {
      throw new Error(`Database entry at index ${index} is missing`);
    }
    const id = getEmbeddingId(databaseEntry);
    if (!isConcreteId(id)) {
      throw new Error(`Database entry at index ${index} has missing stable embedding id`);
    }
    if (!Array.isArray(entry.embedding)) {
      throw new Error(`Embedding entry at index ${index} must include an embedding array`);
    }

    /** @type {EmbeddingArtifactRow} */
    const row = {
      id,
      chengyu: databaseEntry.chengyu,
      embedding: entry.embedding
    };
    if (includeText && entry.text) {
      row.text = entry.text;
    }
    return row;
  });

  return {
    version,
    model,
    ...(modelKey ? { modelKey } : {}),
    template,
    pooling,
    normalize,
    dimensions: rows[0] ? rows[0].embedding.length : 0,
    corpusHash: buildEmbeddingCorpusHash(database, template),
    generatedAt,
    entryCount: rows.length,
    embeddings: rows
  };
}

/**
 * @param {unknown} artifact
 * @param {EmbeddingArtifactRow[]} embeddingEntries
 * @param {ValidationOptions} options
 * @returns {number | null}
 */
function getExpectedDimensions(artifact, embeddingEntries, options) {
  const configuredDimensions = options.expectedDimensions;
  if (Number.isInteger(configuredDimensions) && Number(configuredDimensions) > 0) {
    return Number(configuredDimensions);
  }

  if (artifact && typeof artifact === 'object') {
    const dimensions = /** @type {{ dimensions?: number }} */ (artifact).dimensions;
    if (Number.isInteger(dimensions) && Number(dimensions) > 0) {
      return Number(dimensions);
    }
  }

  const firstVector = embeddingEntries.find(entry => Array.isArray(entry?.embedding))?.embedding;
  return firstVector ? firstVector.length : null;
}

/**
 * @param {string[]} values
 * @param {number} [limit]
 * @returns {string}
 */
function pushLimited(values, limit = 5) {
  const visible = values.slice(0, limit).join(', ');
  return values.length > limit ? `${visible}, ... (${values.length} total)` : visible;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function boolLabel(value) {
  return value === true ? 'true' : value === false ? 'false' : String(value);
}

/**
 * @param {unknown} artifact
 * @param {string[]} diagnostics
 * @param {keyof EmbeddingArtifactObject} field
 * @param {unknown} expectedValue
 * @param {string} [label]
 */
function validateScalarMetadata(artifact, diagnostics, field, expectedValue, label = field) {
  if (expectedValue === undefined || expectedValue === null) return;

  const actualValue = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? /** @type {EmbeddingArtifactObject} */ (artifact)[field]
    : undefined;
  if (actualValue === undefined || actualValue === null || actualValue === '') {
    diagnostics.push(`Embedding artifact missing required ${label} metadata (expected ${boolLabel(expectedValue)})`);
    return;
  }

  if (actualValue !== expectedValue) {
    diagnostics.push(`Embedding artifact ${label} ${boolLabel(actualValue)} does not match expected ${boolLabel(expectedValue)}`);
  }
}

/**
 * @param {unknown} artifact
 * @param {EmbeddingEntry[]} [database]
 * @param {ValidationOptions} [options]
 * @returns {ValidationResult}
 */
function validateEmbeddingArtifact(artifact, database = [], options = {}) {
  const diagnostics = [];
  const embeddingsById = new Map();
  const embeddingEntries = getArtifactEntries(artifact);

  if (!Array.isArray(database)) {
    diagnostics.push('Database corpus must be an array');
  }

  if (!embeddingEntries) {
    diagnostics.push('Embedding artifact must contain an embeddings array');
    return { ok: false, diagnostics, embeddingsById };
  }

  validateScalarMetadata(artifact, diagnostics, 'model', options.expectedModel, 'model');
  validateScalarMetadata(artifact, diagnostics, 'pooling', options.expectedPooling, 'pooling');
  validateScalarMetadata(artifact, diagnostics, 'normalize', options.expectedNormalize, 'normalize');
  validateScalarMetadata(artifact, diagnostics, 'template', options.expectedTemplate, 'template');
  validateScalarMetadata(artifact, diagnostics, 'corpusHash', options.expectedCorpusHash, 'corpus hash');

  const canUseLegacyArtifactIds = options.allowLegacyIds === true
    && embeddingEntries.length === database.length
    && embeddingEntries.length > 0
    && embeddingEntries.every(entry => !isConcreteId(getEmbeddingId(entry)))
    && embeddingEntries.every((entry, index) => entry?.chengyu === database[index]?.chengyu);

  const artifactEntryCount = getArtifactEntryCount(artifact, embeddingEntries);
  if (!Number.isInteger(artifactEntryCount) || artifactEntryCount !== embeddingEntries.length) {
    diagnostics.push(`Embedding artifact entryCount ${artifactEntryCount} does not match actual embedding entry count ${embeddingEntries.length}`);
  }

  const expectedDimensions = getExpectedDimensions(artifact, embeddingEntries, options);
  if (expectedDimensions === null || !Number.isInteger(expectedDimensions) || expectedDimensions <= 0) {
    diagnostics.push(`Embedding dimensions must be a positive integer, got ${expectedDimensions}`);
  }

  validateScalarMetadata(artifact, diagnostics, 'dimensions', expectedDimensions, 'dimensions');

  const databaseIds = new Set();
  const duplicateDatabaseIds = new Set();
  database.forEach((entry, index) => {
    const id = getEmbeddingId(entry);
    if (!isConcreteId(id)) {
      diagnostics.push(`Database entry at index ${index} has missing stable embedding id`);
      return;
    }
    if (databaseIds.has(id)) {
      duplicateDatabaseIds.add(id);
    }
    databaseIds.add(id);
  });

  duplicateDatabaseIds.forEach(id => {
    diagnostics.push(`Duplicate database embedding id: ${id}`);
  });

  const artifactIds = new Set();
  const duplicateArtifactIds = new Set();
  embeddingEntries.forEach((entry, index) => {
    const id = canUseLegacyArtifactIds ? getEmbeddingId(database[index]) : getEmbeddingId(entry);
    const idLabel = isConcreteId(id) ? id : `entry at index ${index}`;

    if (!isConcreteId(id)) {
      diagnostics.push(`Artifact embedding entry at index ${index} has missing stable id`);
    } else if (artifactIds.has(id)) {
      duplicateArtifactIds.add(id);
    } else {
      artifactIds.add(id);
    }

    const vector = entry?.embedding;
    if (!Array.isArray(vector)) {
      diagnostics.push(`${idLabel} embedding must be an array`);
      return;
    }

    if (expectedDimensions !== null && Number.isInteger(expectedDimensions) && expectedDimensions > 0 && vector.length !== expectedDimensions) {
      diagnostics.push(`${idLabel} embedding dimension ${vector.length} does not match expected dimension ${expectedDimensions}`);
    }

    vector.forEach((value, valueIndex) => {
      if (typeof value !== 'number') {
        diagnostics.push(`${idLabel} embedding[${valueIndex}] must be a number`);
      } else if (!Number.isFinite(value)) {
        diagnostics.push(`${idLabel} embedding[${valueIndex}] must be finite`);
      }
    });

    if (isConcreteId(id) && !embeddingsById.has(id)) {
      embeddingsById.set(id, vector);
    }
  });

  duplicateArtifactIds.forEach(id => {
    diagnostics.push(`Duplicate artifact embedding id: ${id}`);
  });

  const missingIds = Array.from(databaseIds).filter(id => !artifactIds.has(id));
  const extraIds = Array.from(artifactIds).filter(id => !databaseIds.has(id));

  if (missingIds.length > 0 || extraIds.length > 0) {
    const parts = [];
    if (missingIds.length > 0) {
      parts.push(`missing database IDs in artifact: ${pushLimited(missingIds)}`);
    }
    if (extraIds.length > 0) {
      parts.push(`extra artifact IDs not present in database: ${pushLimited(extraIds)}`);
    }
    diagnostics.push(parts.join('; '));
  }

  if (artifactIds.size !== embeddingEntries.length) {
    diagnostics.push(`Artifact unique ID count ${artifactIds.size} does not match embedding entry count ${embeddingEntries.length}`);
  }

  if (artifactIds.size !== databaseIds.size) {
    diagnostics.push(`Artifact unique ID count ${artifactIds.size} does not match database ID count ${databaseIds.size}`);
  }

  if (artifactEntryCount !== databaseIds.size) {
    diagnostics.push(`Embedding artifact entryCount ${artifactEntryCount} does not match database ID count ${databaseIds.size}`);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, embeddingsById: new Map() };
  }

  return {
    ok: true,
    diagnostics,
    embeddingsById,
    dimensions: expectedDimensions,
    entryCount: artifactEntryCount
  };
}

module.exports = {
  buildEmbeddingArtifact,
  buildEmbeddingCorpusHash,
  buildEmbeddingTemplateText,
  getEmbeddingId,
  validateEmbeddingArtifact
};

const crypto = require('crypto');

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

function getArtifactEntries(artifact) {
  if (Array.isArray(artifact)) {
    return artifact;
  }
  if (artifact && Array.isArray(artifact.embeddings)) {
    return artifact.embeddings;
  }
  return null;
}

function getArtifactEntryCount(artifact, embeddingEntries) {
  if (Array.isArray(artifact)) {
    return embeddingEntries.length;
  }
  return artifact ? artifact.entryCount : undefined;
}

function getEmbeddingId(value) {
  return value && (value.id || value.embeddingId || value.publicId);
}

function isConcreteId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeTemplateValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeTemplateValue);
  }
  if (value == null) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ');
}

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
    const id = getEmbeddingId(databaseEntry);
    if (!isConcreteId(id)) {
      throw new Error(`Database entry at index ${index} has missing stable embedding id`);
    }
    if (!Array.isArray(entry.embedding)) {
      throw new Error(`Embedding entry at index ${index} must include an embedding array`);
    }

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

function getExpectedDimensions(artifact, embeddingEntries, options) {
  if (Number.isInteger(options.expectedDimensions) && options.expectedDimensions > 0) {
    return options.expectedDimensions;
  }

  if (Number.isInteger(artifact?.dimensions) && artifact.dimensions > 0) {
    return artifact.dimensions;
  }

  const firstVector = embeddingEntries.find(entry => Array.isArray(entry?.embedding))?.embedding;
  return firstVector ? firstVector.length : null;
}

function pushLimited(values, limit = 5) {
  const visible = values.slice(0, limit).join(', ');
  return values.length > limit ? `${visible}, ... (${values.length} total)` : visible;
}

function boolLabel(value) {
  return value === true ? 'true' : value === false ? 'false' : String(value);
}

function validateScalarMetadata(artifact, diagnostics, field, expectedValue, label = field) {
  if (expectedValue === undefined || expectedValue === null) return;

  const actualValue = artifact && !Array.isArray(artifact) ? artifact[field] : undefined;
  if (actualValue === undefined || actualValue === null || actualValue === '') {
    diagnostics.push(`Embedding artifact missing required ${label} metadata (expected ${boolLabel(expectedValue)})`);
    return;
  }

  if (actualValue !== expectedValue) {
    diagnostics.push(`Embedding artifact ${label} ${boolLabel(actualValue)} does not match expected ${boolLabel(expectedValue)}`);
  }
}

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
  if (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0) {
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

    if (Number.isInteger(expectedDimensions) && expectedDimensions > 0 && vector.length !== expectedDimensions) {
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

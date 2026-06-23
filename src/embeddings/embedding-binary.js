/** @ts-check */

const MAGIC = Buffer.from('CHENGYU_EMBEDDINGS_BIN_V1\n');

/**
 * @typedef {{ id?: string, chengyu?: string, embedding: readonly number[] | Float32Array }} BinaryEmbeddingRow
 * @typedef {{ dimensions?: number, entryCount?: number, embeddings?: BinaryEmbeddingRow[], [key: string]: unknown }} BinaryEmbeddingArtifact
 * @typedef {{ id?: string, chengyu?: string }} BinaryEmbeddingMetadataEntry
 * @typedef {{ dimensions?: number, entryCount?: number, entries?: BinaryEmbeddingMetadataEntry[], [key: string]: unknown }} BinaryEmbeddingMetadata
 */

/**
 * @param {BinaryEmbeddingArtifact} artifact
 * @returns {Record<string, unknown>}
 */
function stripEmbeddings(artifact) {
  const { embeddings: _embeddings, ...metadata } = artifact || {};
  return metadata;
}

/**
 * @param {BinaryEmbeddingArtifact} artifact
 * @returns {Buffer}
 */
function writeBinaryEmbeddingArtifact(artifact) {
  if (!artifact || !Array.isArray(artifact.embeddings)) {
    throw new Error('Embedding artifact must contain an embeddings array');
  }

  const entryCount = artifact.embeddings.length;
  const dimensions = Number(artifact.dimensions || artifact.embeddings[0]?.embedding?.length || 0);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('Embedding artifact dimensions must be a positive integer');
  }

  const artifactEmbeddings = artifact.embeddings;
  const entries = artifactEmbeddings.map(entry => {
    if (!entry || !Array.isArray(entry.embedding) || entry.embedding.length !== dimensions) {
      throw new Error('All embeddings must have the declared dimensions');
    }
    return {
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.chengyu !== undefined ? { chengyu: entry.chengyu } : {})
    };
  });

  const metadata = {
    ...stripEmbeddings(artifact),
    format: 'chengyu-embeddings-binary-v1',
    dimensions,
    entryCount,
    entries
  };
  const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  const header = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(metadataBuffer.length, MAGIC.length);

  const vectorBuffer = Buffer.alloc(entryCount * dimensions * 4);
  let offset = 0;
  artifactEmbeddings.forEach(entry => {
    entry.embedding.forEach(value => {
      vectorBuffer.writeFloatLE(Number(value), offset);
      offset += 4;
    });
  });

  return Buffer.concat([header, metadataBuffer, vectorBuffer]);
}

/**
 * @param {Buffer | ArrayBuffer | Uint8Array} buffer
 * @returns {BinaryEmbeddingArtifact & { embeddings: { id?: string, chengyu?: string, embedding: number[] }[], dimensions: number, entryCount: number }}
 */
function readBinaryEmbeddingArtifact(buffer) {
  const binaryBuffer = Buffer.isBuffer(buffer)
    ? buffer
    : buffer instanceof ArrayBuffer
      ? Buffer.from(buffer)
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (binaryBuffer.length < MAGIC.length + 4 || !binaryBuffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid binary embedding artifact magic header');
  }

  const metadataLength = binaryBuffer.readUInt32LE(MAGIC.length);
  const metadataStart = MAGIC.length + 4;
  const metadataEnd = metadataStart + metadataLength;
  if (metadataEnd > binaryBuffer.length) {
    throw new Error('Invalid binary embedding artifact metadata length');
  }

  const metadata = /** @type {BinaryEmbeddingMetadata} */ (JSON.parse(binaryBuffer.subarray(metadataStart, metadataEnd).toString('utf8')));
  const dimensions = Number(metadata.dimensions);
  const entries = metadata.entries;
  if (!Number.isInteger(dimensions) || dimensions <= 0 || !Array.isArray(entries)) {
    throw new Error('Invalid binary embedding artifact metadata');
  }

  const expectedVectorBytes = entries.length * dimensions * 4;
  const vectorStart = metadataEnd;
  if (binaryBuffer.length - vectorStart !== expectedVectorBytes) {
    throw new Error('Binary embedding vector payload length does not match metadata');
  }

  const embeddings = entries.map((entry, entryIndex) => {
    /** @type {number[]} */
    const embedding = new Array(dimensions);
    const entryOffset = vectorStart + entryIndex * dimensions * 4;
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = binaryBuffer.readFloatLE(entryOffset + i * 4);
    }
    return {
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.chengyu !== undefined ? { chengyu: entry.chengyu } : {}),
      embedding
    };
  });

  const { entries: _entries, format: _format, ...artifactMetadata } = metadata;
  return {
    ...artifactMetadata,
    embeddings,
    entryCount: metadata.entryCount || embeddings.length,
    dimensions
  };
}

/**
 * @param {string} [filePath]
 * @returns {boolean}
 */
function isBinaryEmbeddingPath(filePath = '') {
  return String(filePath).toLowerCase().endsWith('.bin');
}

module.exports = {
  isBinaryEmbeddingPath,
  readBinaryEmbeddingArtifact,
  writeBinaryEmbeddingArtifact
};

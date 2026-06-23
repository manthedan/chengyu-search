export type ChengyuId = string;

export type QueryType =
  | 'english_meaning'
  | 'thematic'
  | 'literal'
  | 'partial'
  | 'pinyin'
  | 'chinese_exact';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid' | 'auto';

export interface ChengyuEntry {
  readonly id?: ChengyuId;
  readonly chengyu: string;
  readonly simplified?: string;
  readonly traditional?: string;
  readonly pinyin: string;
  readonly meaning: string;
  readonly literal?: string;
  readonly example?: string;
  readonly tags?: readonly string[];
  readonly formality?: string;
  readonly frequency?: number;
}

export interface EmbeddingMetadata {
  readonly model: string;
  readonly dimensions: number;
  readonly template?: string;
  readonly pooling?: string;
  readonly normalized?: boolean;
  readonly corpusHash?: string;
}

export interface EmbeddingArtifact {
  readonly metadata: EmbeddingMetadata;
  readonly ids: readonly ChengyuId[];
  readonly vectors: readonly Float32Array[];
}

export type EmbeddingIndex = ReadonlyMap<ChengyuId, Float32Array>;

export interface RankedCandidate {
  readonly id?: ChengyuId;
  readonly chengyu: string;
  readonly simplified?: string;
  readonly traditional?: string;
  readonly pinyin?: string;
  readonly meaning?: string;
  readonly literal?: string;
  readonly example?: string;
  readonly score: number;
  readonly keywordScore?: number;
  readonly semanticScore?: number;
  readonly rerankScore?: number;
  readonly searchMode?: SearchMode;
  readonly matchType?: string;
  readonly tags?: readonly string[];
}

export interface SearchRequest {
  readonly query: string;
  readonly mode?: SearchMode;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchResponse {
  readonly query: string;
  readonly mode: SearchMode;
  readonly queryType?: QueryType;
  readonly results: readonly RankedCandidate[];
  readonly count: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
}

export interface CandidateReranker {
  rerank(
    query: string,
    candidates: readonly RankedCandidate[],
  ): Promise<readonly RankedCandidate[]>;
}

export interface RuntimeMetrics {
  recordSearch?(details: Record<string, unknown>): void;
  recordCacheHit?(name: string): void;
  recordCacheMiss?(name: string): void;
}

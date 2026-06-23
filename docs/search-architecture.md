# Search and Embedding Architecture

This document describes the current production search stack in `chengyu-search` as implemented in:

- `api-server.js`
- `autoresearch/search-logic.js`
- `autoresearch/search-config.js`

It is meant to explain how search works today, not to describe every historical experiment.

## 1. System overview

At a high level, the app uses three search modes:

1. **Keyword**
   - Fast lexical retrieval using Fuse.js
   - Handles Chinese, English, and pinyin lookups
2. **Semantic**
   - English-oriented semantic retrieval
   - Blends runtime query embeddings with a strong token-based semantic scorer
3. **Hybrid**
   - Merges keyword, semantic, and exact-pinyin signals
   - Best general-purpose retrieval mode for multilingual traffic

The browser UI calls the **auto-routed** endpoint (`POST /api/search`), and the backend chooses the mode.

## 2. Data loaded at startup

On startup, the server loads:

- **idiom database** from `chengyuData.js`
- **embedding artifact** from compact `embeddings-local.bin` by default (`embeddings-local.json` remains available as a readable source/fallback)
- **runtime embedding model** via `@xenova/transformers`

The current default embedding model is:

- `Xenova/all-MiniLM-L6-v2`

The current promoted baseline embedding artifact was generated from the template:

- `rich`

### Embedding artifact format

The server supports both:

1. **legacy raw array**
2. **metadata-wrapped object**

Current preferred runtime format: `embeddings-local.bin`, a compact binary artifact with metadata plus raw float32 vectors. The readable JSON artifact has the same metadata and embeddings and can be converted with:

```bash
node scripts/convert-embeddings-binary.js --input embeddings-local.json --output embeddings-local.bin
```

The server validates stable IDs, count, dimensions, finite vector values, model, pooling, normalization, template, and corpus hash. If validation fails, semantic search is disabled and hybrid falls back to non-embedding signals.

## 3. Query classification and auto-routing

`classifyQueryType(query)` currently maps queries into these buckets:

- `english_meaning`
- `thematic`
- `literal`
- `partial`
- `pinyin`
- `chinese_exact`

### Classification rules

In simplified form:

- if the query contains Chinese characters → `chinese_exact`
- else if it looks like pinyin made of valid normalized pinyin syllables → `pinyin`
- else if it is a single-word lexical English noun query from a known partial-lookup set (for example concrete animals/body/nature words) → `partial`
- else if it looks like a literal image-based phrase → `literal`
- else if it looks like a short theme/topic query → `thematic`
- else → `english_meaning`

### Auto-routing policy

The backend routes by query-type defaults plus corpus-signal heuristics audited against the benchmark set.

Default mapping:

- `english_meaning` → **semantic**
- `thematic` → **semantic**
- `literal` → **semantic**
- `partial` → **hybrid**
- `pinyin` → **hybrid**
- `chinese_exact` → **hybrid**

Corpus-signal heuristics can redirect lexical English queries to a different mode. For example, strong tag coverage can favor `keyword`, broad concrete nouns can favor `hybrid`, and longer descriptive phrases usually stay on `semantic`.

If semantic search is unavailable or returns no results for an auto-routed semantic query, the server falls back to hybrid. If an auto-routed keyword query returns no results, the server also falls back to hybrid.

## 4. Query preprocessing

English queries are lightly expanded before semantic or hybrid scoring.

Implemented behaviors include:

- punctuation cleanup and normalization
- stopword-aware tokenization and light stemming
- curated synonym expansion
- curated phrase expansions for common benchmark-style English descriptions

Examples of concepts expanded today include:

- `hopeless` → `despair`, `helpless`, `desperate`
- `wealth` → `rich`, `fortune`, `money`
- `war` → `battle`, `fight`, `conflict`
- `nature and scenery` → `landscape`, `pastoral`, `beautiful`

Chinese queries are not passed through English synonym expansion.

## 5. Keyword search

Keyword search is implemented with **Fuse.js** plus extra pinyin logic.

### 5.1 Chinese / mixed queries

For queries containing Chinese characters, Fuse uses a Chinese-oriented field weighting:

- `chengyu`: `0.5`
- `pinyin`: `0.3`
- `meaning`: `0.15`
- `literal`: `0.05`

This makes exact and partial Hanzi matches dominate.

### 5.2 English queries

For English-like queries, Fuse uses English-facing fields:

- `meaning`: `0.38`
- `literal`: `0.28`
- `usage`: `0.14`
- `example`: `0.10`
- `chengyu`: `0.10`
- `pinyin`: `0.05`
- `tags`: `0.20`

### 5.3 Pinyin support

Pinyin retrieval has two layers:

1. **exact normalized pinyin matching**
   - handles numbered and accented pinyin
   - e.g. `gou3 pi4` and `gǒu pì`
2. **Fuse-based pinyin fuzzy search**
   - runs against normalized pinyin strings

Exact pinyin matches receive a large ranking boost in keyword and hybrid ranking.

## 6. Semantic search

Semantic search in this app is not “embedding-only.” It is a **blend of**:

1. a lexical-semantic token scorer
2. cosine similarity between query embedding and idiom embedding

That design is important: the token scorer keeps the system grounded in meaning/literal/tags, while embeddings help with paraphrase and conceptual similarity.

### 6.1 Token-based semantic scorer

For each idiom, the scorer builds semantic features from:

- `meaning`
- `literal`
- `usage`
- `example`
- `tags`

It then computes signals such as:

- field token overlap
- literal overlap ratio
- literal bigram overlap
- multi-gram overlap across meaning/literal/usage/example
- literal phrase containment
- concept overlap across all semantic text
- term-frequency boosts
- weighted Jaccard using cached IDF stats
- query decomposition for long English descriptions
- fuzzy prefix / contains matching on concept tokens

### 6.2 Embedding component

If embeddings are available, the server generates a query embedding with the configured runtime model and computes cosine similarity against the stored idiom embeddings.

The embedding score is clamped to `[0, 1]` and blended with the normalized token score.

### 6.3 Current blend weights

Global defaults:

- `embeddingWeight`: `0.5`
- `tokenWeight`: `0.5`

Current type-specific overrides:

- `english_meaning`
  - `embeddingWeight`: `0.6`
  - `tokenWeight`: `0.4`
- `thematic`
  - `embeddingWeight`: `0.65`
  - `tokenWeight`: `0.35`
- `literal`
  - `embeddingWeight`: `0.35`
  - `tokenWeight`: `0.65`

These values were chosen by holdout benchmarking after promoting the `rich` embedding baseline.

## 7. Hybrid search

Hybrid search calls both keyword and semantic retrieval, then merges them.

### Signals merged in hybrid mode

- keyword results
- semantic results
- exact normalized pinyin matches

### Ranking behavior

- exact pinyin matches get a strong direct boost
- items found by both semantic and keyword search get a combined score
- overlap between both systems is rewarded by a small additive `overlapBonus`

Current high-level merge parameters:

- `semanticWeight`: `0.72`
- `keywordWeight`: `0.28`
- `overlapBonus`: `0.12`
- `tokenScoreScale`: `3` (fixed token-score bound; avoids per-query max normalization)

There is also `autoresearch/hybrid-config.json`, which can further override hybrid ranking at runtime.

## 8. Result shaping

All search endpoints return a normalized response shape with:

- default page size of **10** results
- optional pagination via `limit` and `offset`
- a capped paginated result window of **50** results
- result metadata copied from the idiom database
- a UI-friendly `relevance_score` in the `0–100` range

That `relevance_score` is not the raw benchmark NDCG score. It is a clamped display score derived from internal ranking output.

The browser UI keeps the hot path at 10 results and only requests later pages if the user clicks **Load more results**.

## 9. Caching

The server uses two in-memory caches.

### Embedding cache

- type: LRU
- size: 100
- stores query embeddings

Used by:

- semantic search
- hybrid search
- auto-routed semantic paths

### Search result cache

- type: TTL + LRU
- size: 75
- TTL: 5 minutes
- stores ranked result windows keyed by search mode + trimmed query text

Used by:

- keyword search
- semantic search
- hybrid search
- auto-routed requests after query classification decides the mode

Important consequence:

- the default hot path can still return the first 10 results quickly
- later pages can reuse the cached ranked result window instead of recomputing the whole ranking pipeline
- benchmark runs can bypass this cache with `x-benchmark-bypass-cache: 1`

## 10. Runtime metrics and visibility

The server now exposes a lightweight internal metrics endpoint:

- `GET /api/metrics`

This provides in-memory visibility into:

- request counts by endpoint
- request counts by actual search mode
- request counts by query type
- pagination depth usage via `offset`
- empty-result counts
- load-more usage
- embedding cache hits / misses / bypasses
- ranked-result cache hits / misses / bypasses

Embedding queries and cache keys are canonicalized with Unicode NFKC normalization, lowercasing, whitespace collapse, and conservative trailing sentence-punctuation stripping. The key also includes the embedding model, pooling mode, normalization flag, and an embedding preprocessing version so cache entries cannot silently cross embedding spaces.
- simple latency summaries by endpoint and mode

This is not a full production observability stack, but it is enough to confirm that:

- the default 10-result hot path remains dominant
- cache behavior is healthy
- pagination is not accidentally becoming the main traffic pattern

## 11. Runtime configuration knobs

### Environment variables

- `PORT`
- `EMBEDDINGS_FILE`
- `EMBEDDING_MODEL_ID`
- `EMBEDDING_CACHE_SIZE`
- `SEARCH_CONFIG_OVERRIDE_JSON`
- `SEARCH_CONFIG_OVERRIDE_FILE`
- `QUIET_LOGS`

### Search config files

- base config: `autoresearch/search-config.js`
- hybrid-only overrides: `autoresearch/hybrid-config.json`

`SEARCH_CONFIG_OVERRIDE_JSON` and `SEARCH_CONFIG_OVERRIDE_FILE` are mainly used by the benchmark tooling for non-destructive sweeps.

## 12. Benchmark-driven decisions reflected in the current stack

The current architecture reflects these choices:

- **auto routing** instead of a manual UI mode toggle
- **semantic-by-default** for English-language description traffic
- **hybrid-by-default** for pinyin and Chinese traffic
- **corpus-signal auto-routing heuristics** for audited lexical English queries
- promoted embedding baseline: **MiniLM + rich**
- promoted semantic blend weights tuned against holdout results
- paginated access to deeper results without sacrificing the default 10-result hot path

## 13. Known limitations

The current design still has a few important limitations:

- semantic search is English-oriented and intentionally weak on Hanzi queries
- query classification is heuristic, not model-based
- caches are in-memory only
- there is no external ANN index; semantic retrieval is still full-scan over the in-memory corpus
- benchmark quality depends on the coverage of the labeled test set
- there is no reranker stage yet beyond the current hybrid blending logic

## 14. Future high-ROI directions

The benchmark harness now supports two particularly promising next steps:

1. **additional embedding bakeoffs**
   - better embedding models
   - better document templates
2. **reranking on a short candidate list**
   - especially for difficult English semantic queries

For the current codebase, those are likely better ROI than jumping straight to a larger LLM-centric architecture.

# Search and Embedding Architecture

This document describes the current production search stack in `chengyu-search`.

The runtime is now split by boundary:

- `api-server.js` — process entrypoint, state composition, and server lifecycle
- `src/server/app.js` — Express app composition, middleware, and route mounting
- `src/server/*` — HTTP route helpers, response shaping, runtime metrics, security/rate-limit middleware, and config helpers
- `src/search/search-service.js` — cache-aware search execution, pagination, auto-routing, and fallback behavior
- `src/search/search-logic.js` — query classification, retrieval, scoring, ranking, and fusion primitives
- `src/search/fuzzy-matcher.js` — the keyword engine: an exact, much faster reimplementation of the Fuse.js scoring the site used to run
- `src/search/hosted-search.js` — description search through hosted Qwen embeddings, with fallbacks
- `src/search/variant-grouping.js` — folds forms of one idiom into one result, from `data/variant-families.json`
- `src/search/search-config.js` and `src/search/hybrid-config.json` — promoted ranking configuration
- `src/embeddings/*` — embedding artifact loading/validation, binary formats, query cache keys, the Transformers.js provider (MiniLM), and the hosted Qwen client, recipe and int8 index
- `src/data/*` — corpus loading, stable IDs, and CEDICT variant helpers
- `evaluation/datasets/relevance.json` — labeled relevance set used by benchmarks

Production runtime code should not import from `autoresearch/`; that directory is retained only for legacy/manual experiment scripts.

This document explains how search works today, not every historical experiment.

## 1. System overview

At a high level, the app uses three search modes:

1. **Keyword**
   - Fast lexical retrieval (`src/search/fuzzy-matcher.js`, an exact, faster reimplementation of the Fuse.js 7.1 scoring the site used to run)
   - Handles Chinese, English, and pinyin lookups
2. **Semantic**
   - English-oriented semantic retrieval
   - Blends runtime query embeddings with a strong token-based semantic scorer
3. **Hybrid**
   - Merges keyword, semantic, and exact-pinyin signals
   - Best general-purpose retrieval mode for multilingual traffic

The browser UI calls the **auto-routed** endpoint (`POST /api/search`), and the backend chooses the mode.

In front of these modes sits **description search** (section 6.4). When hosted embeddings are configured, a query that reads as a description (not pinyin, not an idiom's own headword) is embedded by Qwen3-Embedding-0.6B and matched against a checked-in index of every idiom. That is how most English and Chinese descriptions are answered in production. The three modes above serve exact lookups, pinyin and short Chinese queries, and act as the fallback when the hosted service is unavailable.

Every route ends with **variant grouping** (section 8), which folds forms of one idiom (盲人摸象 / 瞎子摸象) into one result.

## 2. Data loaded at startup

On startup, the server loads:

- **idiom database** from `chengyuData.js` via `src/data/corpus-loader.js`
- **embedding artifact** from compact `embeddings-local.bin` by default (`embeddings-local.json` remains available as a readable source/fallback) via `src/embeddings/artifact-loader.js`
- **runtime embedding model** via `@xenova/transformers` through `src/embeddings/transformers-provider.js`

The current default embedding model is:

- `Xenova/all-MiniLM-L6-v2`

The current promoted baseline embedding artifact was generated from the template:

- `rich`

When hosted embeddings are enabled (`HOSTED_EMBEDDINGS=on` plus Cloudflare credentials), the server also loads:

- **the Qwen idiom index**, `embeddings-qwen-i8.bin` by default (`HOSTED_EMBEDDINGS_FILE`), validated against the corpus and the document recipe (section 6.4)

It always tries to load:

- **the variant map**, `data/variant-families.json` (section 8)

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

Keyword search runs on the site's own engine, `src/search/fuzzy-matcher.js`, plus extra pinyin logic.

The site used to run Fuse.js 7.1. The engine is an exact reimplementation of the Fuse profiles the site used: it returns the same matches, scores and order, and it is about 200 times faster on warm queries (about 279 ms to about 1.5 ms at p50, and 1,455 ms to 6.8 ms at p95). How it stays exact:

- **Same distance:** with `ignoreLocation`, Fuse's Bitap search accepts a text at its minimum substring edit distance. The engine computes that distance directly with Myers' bit-parallel algorithm and uses `includes()` for zero-edit matches.
- **Same chunking and scores:** queries are split into the same 32-character chunks (with an overlapping final chunk), each chunk scores `max(0.001, errors / length)`, and field scores combine with the same weights and normalization.
- **Conservative filters:** before any distance is computed, character-signature and trigram filters discard texts that cannot match within the threshold. A filter may let an extra candidate through but never drops a real match.
- **Frozen by tests:** `test/fuzzy-parity.test.js` and `test/fuzzy-e2e.test.js` compare the engine with recorded Fuse output, so any intended ranking change must regenerate those oracles.

Fuse.js remains only as a development dependency, for those parity tests and for regenerating their oracles. The weightings below are the engine's profiles, unchanged from the Fuse configuration.

### 5.1 Chinese / mixed queries

For queries containing Chinese characters, the engine uses a Chinese-oriented field weighting:

- `chengyu`: `0.5`
- `pinyin`: `0.3`
- `meaning`: `0.15`
- `literal`: `0.05`

This makes exact and partial Hanzi matches dominate.

### 5.2 English queries

For English-like queries, the engine uses English-facing fields:

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
2. **fuzzy pinyin search** (the same engine)
   - runs against normalized pinyin strings

Exact pinyin matches receive a large ranking boost in keyword and hybrid ranking.

## 6. Semantic search

Descriptions normally go to hosted Qwen search first (6.4). The blended semantic mode below runs on the server itself: it answers the semantic route when hosted search is off or unavailable, and it feeds hybrid mode.

The local semantic mode is not “embedding-only.” It is a **blend of**:

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

### 6.4 Hosted description search (Qwen)

`src/search/hosted-search.js` wraps the auto, semantic and hybrid routes. It is how production answers descriptions.

**When it applies.** It is used when hosted embeddings are configured and the query reads as a description: not pinyin, not an idiom's exact headword, and, for Chinese, longer than four characters after normalization. Everything else goes to the routes above.

**The model.** Queries are embedded by Qwen3-Embedding-0.6B (`@cf/qwen/qwen3-embedding-0.6b` on Cloudflare Workers AI; 1024 dimensions, unit vectors). Each query is sent with one fixed instruction:

```text
Instruct: Given a description of a situation, retrieve Chinese idioms whose meanings fit the situation.
Query: <the query; Chinese text is compact-normalized>
```

**The index.** Every idiom was embedded once, offline, from a bilingual document and stored in an int8 index (`src/embeddings/qwen-index.js`, format `qwen-row-unit-int8-v1`: one scale per row, about 8 MB for 7,348 idioms). A search embeds only the query, scores all rows by dot product, and keeps the top window. Two document recipes exist, and the index records which one it was built from:

- **`qwen-bilingual-v1`** (default, `src/embeddings/hosted-recipe.js`): headword, English meaning, literal gloss, topic tags, and the Chinese gloss.
- **`qwen-bilingual-situations-v1`** (`src/embeddings/situation-recipe.js`): the same document plus four short usage scenes (two Chinese, two English) describing everyday moments where the idiom fits. People search by describing situations, so these documents match much better: on the release gate this recipe scored 0.725 overall and 0.787 primary NDCG@5, against 0.625 and 0.584 for the previous live configuration. It is selected with `HOSTED_EMBEDDINGS_TEMPLATE=qwen-bilingual-situations-v1` and its own index file, and it needs the generated scenes in `data/ranking-v1-situations.json`.

At startup the index is checked against the corpus hash, the recipe hash (which also covers the Chinese normalizer) and the idiom ID at every row. If any check fails, hosted search is off and the server says why in its log.

**Latency and the pending protocol.** Query vectors are cached (LRU) and concurrent identical queries share one request. The server waits up to `HOSTED_EMBEDDING_WAIT_MS` (1.5 s by default). If the embedding hasn't arrived by then:

- English descriptions get the local fallback results right away.
- The response also carries a `hostedRequestId`. The page re-sends the query with that ID, and the server answers from the finished embedding without paying for it twice.
- Chinese descriptions have no useful lexical fallback, so they return `status: "pending"` until the hosted answer is ready.

**Limits and failure.**

- **Spending cap:** a daily cap on Workers AI usage (`HOSTED_DAILY_NEURONS`), kept in a ledger file that survives restarts.
- **Concurrency:** a cap on concurrent requests.
- **Circuit breaker:** opens after repeated failures.

If the hosted path is unavailable, English descriptions fall back to the local semantic blend (`embeddingSource: "minilm-fallback"`) or to lexical search (`"lexical-fallback"`). Chinese descriptions return a short "temporarily unavailable" message.

**Match strength.** Each hosted response carries `matchStrength`, which is `weak` when the best idiom stands less than 3.85 standard deviations above the corpus mean for that query. It flags about 5% of real queries and about half of keyboard-mash nonsense, so the page words it softly ("looser matches") rather than hiding results.

**Ranking prior.** An optional prior (`RANKING_PRIOR=on`, `data/ranking-v1-prior.json`) can nudge scores by idiom-level features. It is off in the recommended production configuration.

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

There is also `src/search/hybrid-config.json`, which can further override hybrid ranking at runtime.

## 8. Result shaping

All search endpoints return a normalized response shape with:

- default page size of **10** results
- optional pagination via `limit` and `offset`
- a capped paginated result window of **50** results
- result metadata copied from the idiom database
- a UI-friendly `relevance_score` in the `0–100` range

That `relevance_score` is not the raw benchmark NDCG score. It is a clamped display score derived from internal ranking output.

### Variant grouping

`src/search/variant-grouping.js` folds forms of one idiom together on every route, after ranking and before caching and pagination.

- **The map.** `data/variant-families.json` holds graded links between corpus headwords. A `same` link joins two spellings of one idiom; these links are transitive, so they form clusters. A `full_form` link joins a short form's cluster to its full saying's cluster, and it reaches one hop only: 百花齐放 and 百家争鸣 each link to their couplet but not to each other. Each `same` link records which form is more common. An optional `headlines` list names the full sayings that a meaning search shows as their short form.
- **Collapse.** Walking the ranked list in order, a result is dropped when a result kept earlier is related to it. If too few results survive, the ranker is asked for a doubled window, up to the 50-result cap.
- **Display.** On semantic responses a kept result is shown in its family's usual form (the cluster's most common member, or the short form a headline names), keeping its rank and score. A form the user typed exactly is never swapped.
- **Payload.** Each result lists its family in `variants`; see `docs/api-reference.md`.
- **Switches.** `VARIANT_GROUPING=0` turns grouping off. A missing or invalid map also turns it off, with one log line saying why; the server never fails to start over it.

The browser UI keeps the hot path at 10 results and only requests later pages if the user clicks **Load more results**.

## 9. Caching

The server uses two in-memory caches.

### Embedding cache

- type: LRU
- default size: 5,000 entries (`EMBEDDING_CACHE_SIZE`)
- stores query embeddings keyed by embedding-space metadata and canonical query text

Embedding queries and cache keys are canonicalized with NFKC normalization, lowercasing, whitespace collapse, trim, and conservative trailing `.`, `!`, `?` stripping. The cache key also includes model, pooling, normalization flag, and preprocessing version so incompatible embedding spaces do not collide.

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
- `VARIANT_GROUPING` (on unless `0`, `false`, `no` or `off`)
- Hosted description search:
  - `HOSTED_EMBEDDINGS=on`, together with `CF_ACCOUNT_ID` and `CF_API_TOKEN` (Cloudflare Workers AI credentials, which belong in the host's secret store)
  - `HOSTED_EMBEDDINGS_FILE` and `HOSTED_EMBEDDINGS_TEMPLATE`: the index file and its document recipe
  - `HOSTED_EMBEDDING_WAIT_MS`, `HOSTED_EMBEDDING_TIMEOUT_MS`, `HOSTED_EMBEDDING_CACHE_SIZE` and `HOSTED_MAX_INFLIGHT`
  - `HOSTED_DAILY_NEURONS` and `HOSTED_NEURON_LEDGER`: the spending cap and the file that records it
  - `HOSTED_BREAKER_FAILURES` and `HOSTED_BREAKER_COOLDOWN_MS`: the circuit breaker
  - `RANKING_PRIOR`
- `SKIP_MINILM`: don't load the local MiniLM model
- `VARIANT_FAMILIES_FILE` (default `data/variant-families.json`)

### Search config files

- base config: `src/search/search-config.js`
- hybrid-only overrides: `src/search/hybrid-config.json`

`SEARCH_CONFIG_OVERRIDE_JSON` and `SEARCH_CONFIG_OVERRIDE_FILE` are mainly used by the benchmark tooling for non-destructive sweeps.

## 12. Benchmark-driven decisions reflected in the current stack

The current architecture reflects these choices:

- **auto routing** instead of a manual UI mode toggle
- **semantic-by-default** for English-language description traffic
- **hybrid-by-default** for pinyin and Chinese traffic
- **corpus-signal auto-routing heuristics** for audited lexical English queries
- hosted **Qwen3-Embedding-0.6B** for descriptions, with the situations document recipe in production (passed the release gate: 0.725 overall / 0.787 primary NDCG@5, against 0.625 / 0.584 before)
- local fallback embedding baseline: **MiniLM + rich**
- promoted semantic blend weights tuned against holdout results
- a keyword engine that reproduces Fuse.js exactly at a fraction of the cost, so ranking changes and speed work never mix
- **variant grouping**: on the 82-query release gate, production's top 5 held 25 repeated forms of an idiom already shown. Grouping removes all of them, and novelty NDCG@5 on the affected queries rises from 0.868 to 0.945. The release gate passes.
- paginated access to deeper results without sacrificing the default 10-result hot path

Every ranking change is checked by the release gate, `npm run benchmark:relevance -- --gate`. It scores NDCG@5 on 82 labelled queries and requires every top-5 result to have a label. Labels come from `evaluation/datasets/relevance.json`, plus LLM-graded supplements in `relevance-supplement.json` and `relevance-supplement-claude.json`.

## 13. Known limitations

The current design still has a few important limitations:

- the local semantic blend (the fallback) is English-oriented and weak on Hanzi queries; Chinese descriptions depend on the hosted path
- description search depends on a hosted embedding API, with a daily spending cap; when it is unavailable, English falls back to local search and Chinese descriptions return a message
- query classification is heuristic, not model-based
- caches are in-memory only
- there is no external ANN index; both local and hosted retrieval are full scans over the corpus (7,348 rows, which is fast at this size)
- polarity and literal-mention cases are known weak spots, such as a hopeless query ranking an idiom of perseverance first
- benchmark quality depends on the coverage of the labeled test set
- there is no reranker stage yet beyond the current hybrid blending logic

## 14. Dictionary tooltip system

The frontend includes a click-to-lookup dictionary tooltip system powered by offline-pre-segmented data.

### Build pipeline

```bash
npm run dictionary:build
```

This runs `scripts/build-dictionary.js`, which:

1. Downloads CC-CEDICT (if not present) from MDBG
2. Builds a trie from all CEDICT entries plus chengyu headwords not in CEDICT
3. Segments all 7,348 example sentences using dictionary-constrained DP segmentation
4. Segments each chengyu headword into sub-words where possible (e.g. 聪明伶俐 splits as 聪明 + 伶俐)
5. Generates two static artifacts:
   - `public/generated/dictionary-subset.json` - only the dictionary entries referenced by the corpus
   - `public/generated/example-annotations.json` - pre-segmented tokens with entry IDs for every example
6. Reports coverage; exits non-zero if any Chinese character lacks a definition

Vocabulary overrides for rare or variant characters not in CEDICT live in `data/dictionary-overrides.json`.

### Frontend behavior

The browser loads both JSON files at startup. Example sentences render as clickable word tokens. Chengyu headwords render as clickable word groups (or individual characters when no sub-word exists). Clicking any token opens a single reusable popover showing the word, pinyin, traditional form, and definitions. The system gracefully falls back to plain highlighting if the dictionary data fails to load.

## 15. Future high-ROI directions

The benchmark harness now supports two particularly promising next steps:

1. **better document text for the Qwen index** (the situations recipe was the largest gain so far)
2. **exposing calibrated confidence** (a per-result standardized score and a `strong` level) so the page can signal exact or very confident answers
3. **reranking on a short candidate list**
   - especially for difficult English semantic queries

For the current codebase, those are likely better ROI than jumping straight to a larger LLM-centric architecture.

### Chinese headword lookup and query normalization

Chinese lookup first recognizes complete simplified/traditional headwords from the loaded serving records, retaining every distinct sense ID. The compact normalizer under `src/data/chinese-normalizer/` handles other Chinese query text. Its binary dictionary is compiled at build time and loaded lazily; serving does not import the experimental compiler or full normalization dictionaries. A corpus headword can override a general script conversion so the spelling displayed on a card always resolves back to that record.

### Persistent public IDs and saved bookmarks

A serving record's stored `id` is its immutable primary key. Meaning, literal translation, example, tags and formality repairs must retain it. Newly allocated IDs can use the headword/pronunciation seed; records sharing both must receive explicit distinct sense IDs. Embeddings still bind IDs to the exact current template text through their corpus hash, so stable IDs do not make stale vectors valid.

The public bookmark migration asset maps historical content-derived IDs to current persistent IDs before initial rendering. It merges only identical destination IDs, preserving separate senses even when their headwords and pinyin match. A corpus-version marker requests fresh metadata once per corpus update; refresh selects the exact saved ID and leaves unknown or ambiguous records intact. The private gated apply tool pins serving IDs in its identity ledger and updates this public alias/version asset. Neither the private ledger nor audit provenance ships in the public export.

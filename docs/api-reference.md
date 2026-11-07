# API Reference

This document describes the current HTTP API exposed by `api-server.js`.

## Base URL

Local development default:

```text
http://localhost:3000
```

## Content type

Search endpoints expect:

```http
Content-Type: application/json
```

## Common search request body

All search endpoints use the same body shape:

```json
{
  "query": "opportunity",
  "limit": 10,
  "offset": 0
}
```

### Pagination fields

- `limit`
  - optional
  - default: `10`
  - must be a positive integer
  - maximum: `50`
- `offset`
  - optional
  - default: `0`
  - must be a non-negative integer
- `offset + limit`
  - must not exceed `50`
- `query`
  - must be a non-empty string
  - maximum length defaults to `500` characters
  - override with `MAX_QUERY_LENGTH`

The UI uses the default hot path of `10` results and requests later pages only when the user clicks **Load more results**.

If `query` is missing, empty, or not a string, the server returns:

```json
{
  "error": "Query is required"
}
```

with HTTP `400`.

If `query` exceeds the configured maximum length, the server returns:

```json
{
  "error": "query cannot exceed 500 characters"
}
```

with HTTP `400`.

---

## Response model

All search endpoints return this top-level structure:

```json
{
  "query": "opportunity",
  "mode": "semantic",
  "queryType": "english_meaning",
  "preferredMode": "semantic",
  "autoRouted": true,
  "fallbackFrom": null,
  "offset": 0,
  "limit": 10,
  "count": 10,
  "hasMore": true,
  "nextOffset": 10,
  "results": [
    {
      "chengyu": "千载难逢",
      "simplified": "千载难逢",
      "traditional": "千載難逢",
      "pinyin": "qian1 zai3 nan2 feng2",
      "literal": "a thousand years hard to encounter",
      "meaning": "a once-in-a-lifetime opportunity",
      "usage": "...",
      "example": "...",
      "tags": ["opportunity", "rare"],
      "formality": "neutral",
      "relevance_score": 91
    }
  ]
}
```

### Top-level fields

- `query`: original query string
- `mode`: mode that actually produced the response
  - `keyword`
  - `semantic`
  - `hybrid`
- `queryType`: server-side classification bucket
  - `english_meaning`
  - `thematic`
  - `literal`
  - `partial`
  - `pinyin`
  - `chinese_exact`
- `preferredMode`: the mode the router wanted to use
- `autoRouted`: `true` for `/api/search`, `false` for direct mode endpoints
- `fallbackFrom`: populated when auto-routing attempted one mode and then fell back to hybrid (currently semantic or keyword)
- `offset`: pagination start offset used for this response
- `limit`: requested page size
- `count`: number of results returned in this page
- `hasMore`: whether another page can be requested inside the supported result window
- `nextOffset`: offset to use for the next page, or `null`
- `results`: result page payload

Descriptions that go to hosted description search (see `docs/search-architecture.md`, section 6.4) also carry:

- `status`: `complete`; `pending` while the query embedding is still being computed; or `unavailable`
- `embeddingSource`: `hosted-qwen` when the hosted index answered; `minilm-fallback` or `lexical-fallback` when local search answered instead; `pending` or `unavailable` otherwise
- `hostedRequestId`: present when the hosted answer is still on its way. Send the same request again with this field added, and the server answers from the finished embedding. The site does this automatically, upgrading fallback results in place.
- `hostedFallbackReason` and `message`: why the hosted path was not used, and a short user-facing note
- `matchStrength`: `normal` or `weak`. `weak` means the best result stands less than 3.85 standard deviations above the corpus mean for that query. It flags about 5% of real queries and about half of keyboard-mash nonsense, so it is a soft hint, not a cutoff.

### Result fields

- `id`: stable public ID for the entry (bookmarks use it)
- `chengyu`: canonical idiom identifier used by the current corpus, usually simplified
- `simplified`: simplified headword for display/export
- `traditional`: traditional headword for display/export
- `pinyin`
- `literal`
- `meaning`
- `meaning_zh`: Chinese gloss, when available
- `kind`: `chengyu`, `set_phrase`, `official_political` or `technical_or_proper`
- `usage`
- `example`
- `tags`
- `formality`
- `relevance_score`

- `variants`: other forms of the same idiom (see below); an empty array when there are none or grouping is off

`relevance_score` is a display-oriented 0–100 score derived from internal ranking output.

### Variant grouping

Many idioms exist in several forms: 盲人摸象 / 瞎子摸象 / 众盲摸象, or 塞翁失马 and its full saying 塞翁失马焉知非福. The server folds them together, so a page of results never shows two forms of one idiom:

- When a result is related to one ranked above it, it is dropped before pagination. The ranker is asked for a larger window so pages stay full.
- On meaning (semantic) searches, a kept result is shown in its family's usual form, keeping its rank and score. For some full sayings the usual form is the short form (悬梁刺股 for 头悬梁，锥刺股). A form the user typed exactly, in characters or pinyin, is always shown as typed.
- Every result lists the rest of its family in `variants`:

```json
{
  "simplified": "盲人摸象",
  "traditional": "盲人摸象",
  "pinyin": "mang2 ren2 mo1 xiang4",
  "publicId": "…",
  "relation": "same",
  "preferred": true,
  "common": true
}
```

- `relation`: `same` (one idiom written another way) or `full_form` (a short form and the saying it opens or comes from). A `full_form` variant shorter than the result is its short form; a longer one is its full saying.
- `preferred`: the form a meaning search would show for this family.
- `common`: the usual spelling within its own group of `same` forms, so a client can list one short form or full saying without its rarer spellings.

The families come from `data/variant-families.json`, a reviewed map of linked headwords. No entry is removed from the corpus, so IDs and bookmarks are unaffected.

---

## `GET /api/health`

Health and runtime metadata endpoint.

### Example request

```http
GET /api/health
```

### Example response

Development and explicitly verbose environments may return:

```json
{
  "status": "ok",
  "database": true,
  "embeddings": true,
  "embeddingModel": true,
  "embeddingFile": "embeddings-local.bin",
  "embeddingDimensions": 384,
  "embeddingTemplate": "rich",
  "configuredEmbeddingModel": "Xenova/all-MiniLM-L6-v2",
  "loadedEmbeddingModel": "Xenova/all-MiniLM-L6-v2",
  "searchConfigOverride": false,
  "autoRouting": true,
  "defaultRoute": "auto",
  "chengyuCount": 7348
}
```

Production defaults to a trimmed payload intended to avoid exposing unnecessary runtime details.

### Field notes

- `database`: idiom database loaded
- `embeddings`: embedding artifact loaded
- `embeddingModel`: runtime query embedding model initialized
- `embeddingFile`: embedding artifact label when verbose health output is enabled
- `embeddingDimensions`: stored embedding vector size when verbose health output is enabled
- `embeddingTemplate`: embedding document template when verbose health output is enabled
- `configuredEmbeddingModel`: model requested by environment config when verbose health output is enabled
- `loadedEmbeddingModel`: model recorded in embedding artifact metadata when verbose health output is enabled
- `searchConfigOverride`: whether runtime search config overrides are active when verbose health output is enabled
- `autoRouting`: auto-routed endpoint is enabled
- `defaultRoute`: current default UI route
- `chengyuCount`: number of idioms loaded

---

## `GET /api/metrics`

Lightweight runtime metrics endpoint.

This is primarily intended for local operations and benchmarking visibility.
By default, it is available in development and hidden in production unless explicitly enabled.

### Example request

```http
GET /api/metrics
```

### Example response shape

```json
{
  "status": "ok",
  "metrics": {
    "startedAt": "2026-...",
    "uptimeSeconds": 123,
    "requests": {
      "total": 42,
      "by_endpoint": {
        "search_auto": 20,
        "search_semantic": 8,
        "search_hybrid": 5,
        "search_keyword": 4,
        "health": 5
      },
      "by_status": {
        "200": 40,
        "400": 2
      },
      "by_mode": {
        "semantic": 18,
        "hybrid": 19,
        "keyword": 3
      },
      "by_query_type": {
        "english_meaning": 14,
        "pinyin": 8,
        "chinese_exact": 6
      },
      "by_offset": {
        "0": 38,
        "10": 2
      },
      "empty_results": 1,
      "load_more_requests": 2
    },
    "caches": {
      "embedding": {
        "hits": 10,
        "misses": 5,
        "bypasses": 0
      },
      "ranked_results": {
        "hits": 12,
        "misses": 9,
        "bypasses": 0,
        "by_mode": {
          "semantic": {
            "hits": 5,
            "misses": 3,
            "bypasses": 0
          }
        }
      }
    },
    "latency_ms": {
      "overall": {
        "count": 40,
        "avg": 98.4,
        "min": 0.5,
        "max": 394.2,
        "total": 3936.0
      },
      "by_endpoint": {},
      "by_mode": {}
    }
  }
}
```

### Notes

- metrics are in-memory only
- they reset when the process restarts
- `/api/metrics` is currently unauthenticated and intended for internal use
- useful fields include:
  - ranked-result cache hit/miss counts
  - embedding cache hit/miss counts
  - pagination depth usage via `by_offset`
  - empty-result rate and load-more usage

---

## `POST /api/search`

Recommended endpoint.

The backend classifies the query and auto-routes it.

### Current routing policy

`/api/search` uses query-type defaults plus corpus-signal heuristics audited against the benchmark set.

Default mapping:

- `english_meaning` → semantic
- `thematic` → semantic
- `literal` → semantic
- `partial` → hybrid
- `pinyin` → hybrid
- `chinese_exact` → hybrid

Audited lexical English queries can still route to `keyword`, `semantic`, or `hybrid` based on corpus signals such as tag coverage, phrase matches, and concrete-noun ambiguity.

If semantic search fails or returns no results, the endpoint falls back to hybrid. If an auto-routed keyword query returns no results, it also falls back to hybrid.

### Example request

```http
POST /api/search
Content-Type: application/json

{
  "query": "adding something unnecessary and ruining it",
  "limit": 10,
  "offset": 0
}
```

### Example response

```json
{
  "query": "adding something unnecessary and ruining it",
  "mode": "semantic",
  "queryType": "english_meaning",
  "preferredMode": "semantic",
  "autoRouted": true,
  "fallbackFrom": null,
  "count": 10,
  "results": []
}
```

### Semantic fallback example

```json
{
  "query": "...",
  "mode": "hybrid",
  "queryType": "english_meaning",
  "preferredMode": "semantic",
  "autoRouted": true,
  "fallbackFrom": "semantic",
  "count": 10,
  "results": []
}
```

### Errors

#### `400 Bad Request`

```json
{
  "error": "Query is required"
}
```

#### `503 Service Unavailable`

Possible if the search engine is not initialized:

```json
{
  "error": "Search engine not initialized"
}
```

#### `500 Internal Server Error`

```json
{
  "error": "Auto search failed",
  "message": "...",
  "fallbackToHybrid": false
}
```

---

## `POST /api/search/keyword`

Direct lexical search mode.

Useful for:

- exact lookups
- Hanzi search
- pinyin search
- debugging lexical behavior

### Example request

```http
POST /api/search/keyword
Content-Type: application/json

{
  "query": "gǒu pì",
  "limit": 10,
  "offset": 0
}
```

### Example response notes

- `mode` will be `keyword`
- `autoRouted` will be `false`
- `preferredMode` will also be `keyword`

### Errors

#### `400 Bad Request`

```json
{
  "error": "Query is required"
}
```

#### `503 Service Unavailable`

```json
{
  "error": "Search engine not initialized"
}
```

#### `500 Internal Server Error`

```json
{
  "error": "Keyword search failed",
  "message": "..."
}
```

---

## `POST /api/search/semantic`

Direct semantic mode.

Useful for:

- English meaning queries
- benchmarking semantic retrieval directly
- debugging semantic-only ranking

### Example request

```http
POST /api/search/semantic
Content-Type: application/json

{
  "query": "opportunity",
  "limit": 10,
  "offset": 0
}
```

### Example response notes

- `mode` will be `semantic`
- `autoRouted` will be `false`

### Errors

#### `400 Bad Request`

```json
{
  "error": "Query is required"
}
```

#### `503 Service Unavailable`

If embeddings or the runtime embedding model are unavailable:

```json
{
  "error": "Semantic search unavailable. Use hybrid search instead.",
  "message": "Semantic search unavailable. Use hybrid search instead.",
  "fallbackToHybrid": true
}
```

#### `500 Internal Server Error`

```json
{
  "error": "Semantic search failed",
  "message": "...",
  "fallbackToHybrid": false
}
```

---

## `POST /api/search/hybrid`

Direct hybrid mode.

Useful for:

- multilingual search
- Chinese and pinyin queries
- debugging merged keyword + semantic ranking

### Example request

```http
POST /api/search/hybrid
Content-Type: application/json

{
  "query": "狗屁不通",
  "limit": 10,
  "offset": 0
}
```

### Example response notes

- `mode` will be `hybrid`
- `autoRouted` will be `false`
- pinyin exact matches can outrank other signals heavily

### Errors

#### `400 Bad Request`

```json
{
  "error": "Query is required"
}
```

#### `500 Internal Server Error`

```json
{
  "error": "Hybrid search failed",
  "message": "..."
}
```

---

## Benchmarking-only request headers

These headers exist mainly for the benchmark tooling.

### `x-benchmark-bypass-cache: 1`

Supported on:

- `POST /api/search`
- `POST /api/search/keyword`
- `POST /api/search/semantic`
- `POST /api/search/hybrid`

Effect:

- bypasses cached ranked result windows for the active search mode

### `x-benchmark-bypass-embedding-cache: 1`

Supported on:

- `POST /api/search`
- `POST /api/search/semantic`
- `POST /api/search/hybrid`

Effect:

- bypasses cached query embeddings

These headers make it possible to measure cold vs warm latency meaningfully.

In production, benchmark bypass headers are ignored by default. Set `ENABLE_BENCHMARK_BYPASS=1` only for controlled benchmark runs where public callers cannot abuse cold-cache paths.

---

## Pagination notes

- default responses still return `10` results
- the API supports deeper paging within a capped window of `50` results
- the backend keeps the default hot path fast by caching ranked result windows per query/mode and slicing them per page
- the frontend currently uses this through a **Load more results** button

---

## CORS and frontend serving

The server currently:

- allows all origins in development
- requires `CORS_ALLOWLIST` matches in production when browser requests send an `Origin`
- does not trust `X-Forwarded-For` by default; rate limiting uses the socket peer address unless `TRUST_PROXY` is explicitly configured
- parses JSON bodies with `express.json()` using `JSON_BODY_LIMIT` or a `16kb` default
- serves the static frontend from `public/`

That means the same server handles both:

- browser UI assets
- JSON API requests

---

## Environment variables relevant to the API

- `PORT`
- `EMBEDDINGS_FILE`
- `EMBEDDING_MODEL_ID`
- `EMBEDDING_CACHE_SIZE`
  - positive integer; defaults to `5000` cached query embeddings
- `SEARCH_CONFIG_OVERRIDE_JSON`
- `SEARCH_CONFIG_OVERRIDE_FILE`
- `QUIET_LOGS`
- `JSON_BODY_LIMIT`
- `MAX_QUERY_LENGTH`
- `CORS_ALLOWLIST`
- `ENABLE_RATE_LIMIT`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `TRUST_PROXY`
  - unset / `0` / `false`: do not trust forwarded IP headers
  - `1` / `true`: trust one proxy hop
  - positive integer: trust that many proxy hops
  - other Express-compatible values such as named subnets or CIDR lists are passed through
- `EXPOSE_RUNTIME_METRICS`
- `EXPOSE_VERBOSE_HEALTH`
- `ENABLE_BENCHMARK_BYPASS`
- `ENABLE_HSTS`
- `HSTS_MAX_AGE_SECONDS`
- `HSTS_INCLUDE_SUBDOMAINS`
- `HSTS_PRELOAD`

These are especially useful for benchmarking, deployment hardening, and controlled bakeoff runs.

---

## Stability notes

Current API behavior is optimized for the local app and benchmarking workflows.

The API currently includes pagination, JSON body limits, query length limits, lightweight per-IP search rate limiting, production-trimmed health output, and production-hidden metrics by default.

The API does **not** currently include:

- authentication / API keys
- per-key quotas
- formal versioning
- externally published schema definitions

If this becomes a public API, those would be the next things to formalize.

---

## Dictionary tooltip data

The frontend serves two static JSON files under `/generated/` that power the click-to-lookup dictionary tooltip system:

- `GET /generated/dictionary-subset.json` - dictionary entries referenced by the corpus
- `GET /generated/example-annotations.json` - pre-segmented example sentence tokens with entry IDs

These are build artifacts generated by:

```bash
npm run dictionary:build
```

The build script downloads CC-CEDICT if needed, segments all examples and headwords, and writes both files plus a coverage report. The browser fetches them at startup; if either fails to load, the UI falls back to plain rendering without tooltips. See `docs/search-architecture.md` for full details.

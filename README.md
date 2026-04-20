# 成语搜索引擎 Chengyu Search Engine

A hybrid search engine for Chinese idioms (成语 / chengyu).
Describe a situation in English, Chinese, or pinyin and find a fitting idiom fast.

## Highlights

- **Automatic search routing**
  - English natural-language descriptions usually prefer semantic search
  - Chinese, pinyin, and mixed-language queries usually prefer hybrid search
  - a small benchmark-backed override layer can route some lexical English queries to `keyword`, `semantic`, or `hybrid`
  - the UI no longer exposes a manual toggle
- **Deeper results on demand**
  - the default hot path returns 10 results fast
  - users can load more results when they want to dig deeper
- **Keyword search still exists as an API mode**
  - useful for direct lookups and debugging
  - supports English, 汉字, and pinyin
  - accented pinyin like `gǒu pì` works
- **5,900+ idioms** with:
  - pinyin
  - English meanings
  - literal translations
  - usage notes
  - example sentences
  - tags and formality labels

## Project Status

- actively maintained search prototype with both a browser UI and HTTP API
- benchmark-driven search/routing iteration rather than one-off tuning
- includes formal relevance, holdout, latency, failure-review, and route-audit tooling
- focused on idiom search quality, not on being a general-purpose Chinese dictionary

## Search Routing

### Automatic UI routing
The browser UI calls the auto-routed endpoint and lets the backend choose the strategy.

Current policy:
- **Semantic** by default for English natural-language description queries
- **Hybrid** by default for Chinese, pinyin, and mixed-language queries
- **Benchmark-backed query overrides** can route a small set of lexical English queries to the audited best mode, including `keyword` for some exact lexical/theme lookups

### Direct API modes
You can still call the explicit modes directly:
- `keyword`
- `semantic`
- `hybrid`

## Architecture

### Backend
- Node.js + Express
- Loads the idiom database and embeddings into memory on startup
- Exposes REST endpoints for:
  - health
  - keyword search
  - semantic search
  - hybrid search
- Reuses the same core ranking logic for the API and the autoresearch harness

### Frontend
- Plain HTML/CSS/JS
- Calls the backend API
- Uses **automatic backend routing** instead of a manual mode toggle

### Search stack
- **Keyword retrieval**: Fuse.js
- **Semantic reranking / query embeddings**: `@xenova/transformers`
- **Local checked-in idiom embeddings**: `embeddings-local.json`

## Local Development

### Requirements
- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run the app

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

### Run tests

```bash
npm test
```

The test suite starts the API server automatically on an ephemeral port.
You do **not** need to start a separate server first.

## Documentation

- Search internals: `docs/search-architecture.md`
- HTTP API reference: `docs/api-reference.md`
- Benchmark toolkit: `benchmark/README.md`
- Contributor guide: `CONTRIBUTING.md`

## API

### Health
```http
GET /api/health
```

### Runtime metrics
```http
GET /api/metrics
```

### Auto-routed search (recommended)
```http
POST /api/search
Content-Type: application/json

{
  "query": "adding something unnecessary and ruining it"
}
```

### Hybrid search
```http
POST /api/search/hybrid
Content-Type: application/json

{
  "query": "狗屁不通"
}
```

### Keyword search
```http
POST /api/search/keyword
Content-Type: application/json

{
  "query": "gǒu pì"
}
```

### Semantic search
```http
POST /api/search/semantic
Content-Type: application/json

{
  "query": "opportunity"
}
```

If semantic search is unavailable, the auto-routed endpoint falls back to hybrid search.

For the full response schema, endpoint behavior, pagination fields, and benchmark-only headers, see `docs/api-reference.md`.

## Deployment

### Render
This repo includes `render.yaml` for a basic Render deployment.

Typical flow:
1. Push to GitHub
2. Create a new Render Web Service
3. Point it at this repo
4. Render will use `render.yaml`

### Environment variables
Optional:
- `PORT` - server port
- `NODE_ENV` - set to `production` in deployed environments
- `EMBEDDINGS_FILE` - override the embedding file path (useful for bakeoffs)
- `EMBEDDING_MODEL_ID` - override the query embedding model (must match the embedding file's model)

## Repository Layout

- `api-server.js` — Express API server and routing layer
- `public/` — browser UI
- `autoresearch/` — core search logic and research helpers
- `benchmark/` — benchmark, bakeoff, and tuning commands
- `docs/` — technical and planning docs
- `test/` — regression tests

## Testing and CI

- `npm test` runs the search-quality regression suite locally
- `npm run benchmark:relevance` runs the formal relevance benchmark for the auto-routed endpoint
- `npm run benchmark:modes` compares `auto`, `semantic`, `hybrid`, and `keyword`
- `npm run benchmark:latency` reports latency across a stratified sample of benchmark queries
- `npm run benchmark:holdout` compares development vs holdout relevance on a deterministic stratified split
- `npm run benchmark:embeddings` runs a non-destructive embedding/model bakeoff
- `npm run benchmark:weights` sweeps semantic blend-weight profiles against the current promoted baseline
- `npm run benchmark:reranker` evaluates optional reranker profiles against the current promoted baseline
- GitHub Actions CI is configured in `.github/workflows/ci.yml`

The regression test suite covers:
- English keyword quality
- Chinese character matching
- numbered and accented pinyin
- semantic relevance
- curated hybrid example queries
- mixed-language and long-query edge cases

The benchmark toolkit is documented in `benchmark/README.md`.

## Data Sources

- **Chengyu database**: CC-CEDICT
- **Examples / translations / enrichment**: assisted curation
- **Embeddings**: local checked-in embeddings used by the backend

## Contributing

See `CONTRIBUTING.md` for setup, expectations, and benchmark guidance for search changes.

## License

This repository has a split license / attribution model:

- **Code and project-authored docs**: MIT — see `LICENSE`
- **Chengyu data and derived corpus artifacts**: CC BY-SA 4.0 / CC-CEDICT attribution — see `DATA_LICENSE.md` and `NOTICE.md`

In practice, files like `chengyuData.js` and `embeddings-local.json` should be treated as data-derived artifacts, not MIT-only source code.

---

祝你学习愉快！

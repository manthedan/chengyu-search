# 成语搜索引擎 Chengyu Search

![Chengyu Search — findchengyu.com](public/readme-brand-lockup.svg)

**Live site:** [findchengyu.com](https://findchengyu.com)

**Chengyu Search** is the product name. **findchengyu.com** is its canonical home.

A hybrid search engine for Chinese idioms (成语 / chengyu).
Describe a situation in English, Chinese, or pinyin and find a fitting idiom fast.

Search over 7,300+ chengyu with examples!

Highlights:

- Automatic search routing for English descriptions, Chinese characters, and pinyin
- Simplified/traditional headword display toggle
- Local saved idioms shelf
- Anki-friendly TSV export with separate columns for headword, simplified, traditional, pinyin, tone pinyin, meaning, literal, example, tags, and formality

## Documentation

- Search internals: `docs/search-architecture.md`
- HTTP API reference: `docs/api-reference.md`
- Engineering roadmap: `docs/engineering-roadmap.md`
- Benchmark toolkit: `benchmark/README.md`
- Contributor guide: `CONTRIBUTING.md`

### Backend
- Node.js + Express
- Modular runtime under `src/` with separate server, search, embedding, and data boundaries

### Frontend
- Plain HTML/CSS/JS

### Search stack
- **Keyword retrieval**: `src/search/fuzzy-matcher.js`, an exact, faster reimplementation of Fuse.js 7.1 scoring
- **Description search**: hosted Qwen query embeddings against a checked-in idiom index (`embeddings-qwen-i8.bin`), with a local MiniLM fallback
- **Semantic reranking / query embeddings**: `@xenova/transformers`
- **Variant grouping**: forms of one idiom (盲人摸象 / 瞎子摸象, 塞翁失马 / 塞翁失马焉知非福) are folded into one result from a reviewed map, `data/variant-families.json`
- **Local checked-in idiom embeddings**: compact `embeddings-local.bin` artifact (`embeddings-local.json` remains as a readable source/fallback)
- **Evaluation**: labeled relevance set in `evaluation/datasets/relevance.json` plus benchmark tooling in `benchmark/`

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

## Data Sources

- **Chengyu database**: CC-CEDICT
- **Examples / literal translations / enrichment**: LLM-assisted curation with maintainer review
- **Embeddings**: local checked-in embeddings used by the backend

## License

This repository has a split license / attribution model:

- **Code and project-authored docs**: MIT — see `LICENSE`
- **Chengyu data and derived corpus artifacts**: CC BY-SA 4.0 / CC-CEDICT attribution — see `DATA_LICENSE.md` and `NOTICE.md`

In practice, files like `chengyuData.js`, `embeddings-local.bin`, and `embeddings-local.json` should be treated as data-derived artifacts, not MIT-only source code.

---

祝你学习愉快！

# 成语搜索引擎 Chengyu Search

![Chengyu Search — findchengyu.com](public/readme-brand-lockup.svg)

**Live site:** [findchengyu.com](https://findchengyu.com)

**Chengyu Search** is the product name. **findchengyu.com** is its canonical home.

A hybrid search engine for Chinese idioms (成语 / chengyu).
Describe a situation in English, Chinese, or pinyin and find a fitting idiom fast.

Search over 5,900+ chengyu with examples!

Highlights:

- Automatic search routing for English descriptions, Chinese characters, and pinyin
- Simplified/traditional headword display toggle
- Local saved idioms shelf
- Anki-friendly TSV export with separate columns for headword, simplified, traditional, pinyin, tone pinyin, meaning, literal, usage, example, tags, and formality

## Documentation

- Search internals: `docs/search-architecture.md`
- HTTP API reference: `docs/api-reference.md`
- Benchmark toolkit: `benchmark/README.md`
- Contributor guide: `CONTRIBUTING.md`

### Backend
- Node.js + Express

### Frontend
- Plain HTML/CSS/JS

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

## Data Sources

- **Chengyu database**: CC-CEDICT
- **Examples / literal translations / enrichment**: LLM-assisted curation with maintainer review
- **Embeddings**: local checked-in embeddings used by the backend

## License

This repository has a split license / attribution model:

- **Code and project-authored docs**: MIT — see `LICENSE`
- **Chengyu data and derived corpus artifacts**: CC BY-SA 4.0 / CC-CEDICT attribution — see `DATA_LICENSE.md` and `NOTICE.md`

In practice, files like `chengyuData.js` and `embeddings-local.json` should be treated as data-derived artifacts, not MIT-only source code.

---

祝你学习愉快！

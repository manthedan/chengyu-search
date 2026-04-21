# Contributing

Thanks for your interest in improving Chengyu Search.

For public-facing branding: **Chengyu Search** is the product name, and **findchengyu.com** is the main live home of the app.

## What kinds of contributions are useful

Good contributions include:
- search quality improvements
- benchmark/test coverage improvements
- bug fixes in routing, ranking, pagination, or API behavior
- documentation improvements
- tooling that makes benchmark-driven iteration easier

## Local setup

```bash
npm install
npm start
```

Run tests with:

```bash
npm test
```

## If you change search behavior

Please prefer benchmark-backed changes over intuition-only tuning.

Useful commands:

```bash
npm run benchmark:modes
npm run benchmark:holdout
npm run benchmark:failures
npm run benchmark:routes
```

If you change embeddings, search weights, or routing policy, include benchmark evidence in the PR/commit message or accompanying notes.

## Before opening a PR

At minimum:
- run `npm test`
- update docs if API behavior or routing behavior changed
- avoid committing large generated benchmark artifacts unless they are intentionally part of the change

## Repo structure

- `api-server.js` — Express API server
- `public/` — browser UI
- `autoresearch/` — search logic and research-oriented helpers
- `benchmark/` — benchmark and tuning toolkit
- `docs/` — technical/project docs
- `test/` — regression tests

## Licensing note

Code contributions are accepted under the repository's code license terms in `LICENSE`.

Data and corpus-derived files have separate attribution / license constraints because this project derives from CC-CEDICT. See:
- `DATA_LICENSE.md`
- `NOTICE.md`

If you contribute changes to corpus-derived data or derivative artifacts, those changes should be understood in that same repository data-license context.

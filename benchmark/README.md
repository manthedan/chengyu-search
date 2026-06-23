# Benchmarking

This directory contains the formal quality benchmark scripts for the app.

## Goals

We want benchmarking to answer four separate questions:

1. **Relevance** — are results getting better?
2. **Mode selection** — which search mode is best for a given traffic mix?
3. **Latency** — how expensive are the different modes?
4. **Holdout generalization** — are we improving on unseen labeled queries, not just the queries we keep staring at?

## Scripts

### Embedding bakeoff

Generate alternative embedding files without touching the current baseline:

```bash
npm run benchmark:embeddings:generate -- --list
npm run benchmark:embeddings:generate -- --variants minilm:english-dense,bge-small:english-dense
```

Run a full embedding bakeoff across variants:

```bash
npm run benchmark:embeddings
npm run benchmark:embeddings -- --variants current,minilm:english-dense,bge-small:english-dense
```

The bakeoff is intentionally non-destructive:
- generated files go under `embeddings/variants/`
- the current compact `embeddings-local.bin` baseline is left untouched
- the server is configured per run with `EMBEDDINGS_FILE` and `EMBEDDING_MODEL_ID`
- search-weight sweeps can also inject `SEARCH_CONFIG_OVERRIDE_JSON` without editing checked-in config
- results are ranked primarily by **holdout auto semantic-routed NDCG**

The bakeoff summary also reports:
- auto holdout overall NDCG
- semantic holdout semantic-routed NDCG
- cold latency for semantic / auto

### Relevance benchmark

Recommended default:

```bash
npm run benchmark:relevance
```

That benchmarks the **auto-routed** search endpoint and reports:
- `primary_avg_ndcg` — current primary score (`english_meaning` + `thematic`)
- `overall_avg_ndcg` — average across all labeled query types
- per-type scores

Benchmark a specific mode:

```bash
node benchmark/relevance.js --mode semantic
node benchmark/relevance.js --mode hybrid
node benchmark/relevance.js --mode keyword
```

Use an already-running server instead of booting one automatically:

```bash
node benchmark/relevance.js --mode hybrid --use-existing --port 3000
```

### Failure review

```bash
npm run benchmark:failures
```

This surfaces the worst-performing queries for a given mode and shows:
- query text
- query type
- NDCG loss
- expected top labeled idioms
- actual top returned idioms

Useful options:

```bash
node benchmark/failures.js --mode auto --top 15
node benchmark/failures.js --mode semantic --save
```

### Route audit

```bash
npm run benchmark:routes
```

This compares `auto` against the explicit modes per query and flags likely routing mismatches where:
- an explicit mode beats auto by a meaningful margin
- and the winning explicit mode differs from the mode auto actually used

Useful options:

```bash
node benchmark/route-audit.js --top 20 --min-delta 0.05
node benchmark/route-audit.js --modes semantic,hybrid --save
```

### Mode comparison

```bash
npm run benchmark:modes
```

This compares:
- `auto`
- `semantic`
- `hybrid`
- `keyword`

and reports the best mode for:
- overall mixed traffic
- the current primary slice

### Weight bakeoff

```bash
npm run benchmark:weights
```

This runs a non-destructive sweep of search-config profiles against the current promoted embedding baseline.

It is intended for tuning semantic blend weights such as:
- `typeOverrides.english_meaning.embeddingWeight`
- `typeOverrides.thematic.embeddingWeight`
- `typeOverrides.literal.embeddingWeight`

The ranking prioritizes:
- holdout auto semantic-routed NDCG
- holdout auto overall NDCG
- semantic cold latency

### Reranker bakeoff

```bash
npm run benchmark:reranker
```

This evaluates optional semantic candidate-reranker profiles against the current promoted baseline.

Use it to answer:
- does a second-pass reranker help the semantic-routed slice?
- does it preserve mixed holdout quality?
- what is the cold-latency cost?

### Holdout benchmark

```bash
npm run benchmark:holdout
```

This creates a deterministic stratified split of the labeled benchmark set into:
- a **development** slice for tuning
- a **holdout** slice for final checking

Default behavior:
- fixed seed: `holdout-v1`
- holdout ratio: `0.25`
- compares `auto`, `semantic`, `hybrid`, and `keyword` on both splits

Customize the split:

```bash
node benchmark/holdout.js --holdout-ratio 0.3 --seed experiment-2
node benchmark/holdout.js --include-split-queries
```

### Latency benchmark

```bash
npm run benchmark:latency
```

Default behavior:
- samples a small stratified subset of the labeled benchmark queries
- runs each mode
- reports average, p50, p95, min, and max latency

Customize the sample:

```bash
node benchmark/latency.js --per-type 3 --warmup 1
```

## Output conventions

- **stdout**: machine-readable JSON
- **stderr**: human-readable summary

This makes the scripts usable both in shell automation and in manual benchmarking.

### Saving benchmark artifacts

Core benchmark commands support artifact writing:

```bash
node benchmark/relevance.js --save
node benchmark/modes.js --save
node benchmark/holdout.js --save
node benchmark/latency.js --save
```

Default artifact location:

```text
benchmark/results/
```

You can also choose an explicit file or directory:

```bash
node benchmark/modes.js --output benchmark/results/modes-manual.json
node benchmark/holdout.js --output-dir benchmark/results/nightly
```

### CI automation

The repo also includes a dedicated GitHub Actions benchmark workflow that can be run:
- manually via `workflow_dispatch`
- nightly on a schedule

It writes benchmark JSON to `benchmark/results/nightly/` during the run and uploads the files as workflow artifacts.

## Current benchmark definitions

### Primary slice
The current primary metric is based on:
- `english_meaning`
- `thematic`

This matches the historical tuning convention used before the labeled dataset moved under `evaluation/`.

### Semantic-routed slice
For embedding/model experiments we also track a fixed semantic-routed slice:
- `english_meaning`
- `thematic`
- `literal`

That corresponds to the query types currently routed to semantic search by the app.

### Overall slice
The overall score includes all labeled query types in `evaluation/datasets/relevance.json`.

## Relationship to production code and experiments

- `src/` contains production search/data/embedding modules used by the API.
- `evaluation/datasets/relevance.json` contains the labeled relevance dataset used by the benchmark toolkit.
- `benchmark/` is the **formal product-facing benchmark toolkit**.
- `autoresearch/` is retained only for legacy/manual experiment scripts; production code should not import from it.
- the holdout split is meant to reduce accidental benchmark overfitting during manual tuning.

The old `autoresearch/benchmark-real.js` remains as a compatibility wrapper around the benchmark utilities.

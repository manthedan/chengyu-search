# Engineering Roadmap

> **Status (2026-11-06): historical plan.** Written 2026-06-23, right after the `src/` architecture split. The first phases of Track 1 (TypeScript) and Track 2 (frontend modules) shipped the same day; Track 3 (artifact inventory) has not been written. The search stack has also moved on since: `npm run check` now runs the type check, the tests and the relevance release gate (`npm run benchmark:relevance -- --gate`, with LLM-labelled supplements in `evaluation/datasets/relevance-supplement*.json`); English and long Chinese descriptions are embedded by Qwen3-Embedding-0.6B on Cloudflare Workers AI and scanned against a checked-in int8 index, with local MiniLM/lexical search as fallback (2026-10); Fuse.js was replaced by `src/search/fuzzy-matcher.js` with identical rankings and warm keyword latency down from ~279/1455 ms to ~1.5/6.8 ms p50/p95 (2026-11-05); and hosted results carry `matchStrength`, variant forms are grouped into one result, and the results page was redesigned (2026-11-06). For the current system, see `docs/search-architecture.md` and `docs/api-reference.md`.

This document captures the next larger refactor tracks after the `src/` architecture split. These are intentionally paced separately from the search-quality work so production behavior stays benchmark-backed.

## Current baseline

- Production runtime modules live under `src/server`, `src/search`, `src/embeddings`, and `src/data`.
- `api-server.js` is a lifecycle/composition entrypoint with an explicit `createApp()` boundary.
- `npm run check` is the local gate: unit/regression tests plus relevance benchmark thresholds. *(Since 2026-06 it also runs `npm run typecheck`; since 2026-10 the benchmark step is the `--gate` release gate.)*
- `npm run smoke:prod` validates the deployed health endpoint and representative search flows.
- Public export is generated from an allowlist and remains separate from the GitLab deployment source.

## Track 1: TypeScript migration planning

### Goal

Add stronger contracts around the server/search/data boundaries without rewriting the product in one risky step.

### Preferred approach

1. **Enable type checking for JavaScript first.**
   - Add `// @ts-check` selectively to small leaf modules.
   - Add JSDoc typedefs for shared shapes like search results, corpus entries, embedding metadata, and benchmark result payloads.
   - Run `tsc --allowJs --checkJs --noEmit` as a non-blocking exploratory command before making it part of `npm run check`.
2. **Create shared type definitions.**
   - Define corpus/search/embedding response contracts in one place.
   - Keep runtime validation for external artifacts; TypeScript does not replace artifact metadata checks.
3. **Convert leaf modules before orchestration modules.**
   - Good first candidates: `src/shared/cache.js`, `src/embeddings/embedding-cache.js`, and pure scoring/config helpers.
   - Later candidates: route helpers and `api-server.js` once service boundaries are stable.
4. **Keep CommonJS until conversion pressure is clear.**
   - Avoid mixing an ESM migration into the TypeScript migration unless there is a concrete benefit.

### Guardrails

- Do not change ranking behavior as part of type-only changes.
- Do not loosen embedding artifact validation to satisfy types.
- Require `npm run check` after every conversion slice.
- Prefer small commits that convert one module family at a time.

### Done criteria for first phase

*Met 2026-06-23: `tsconfig.json` (strict, `allowJs`/`checkJs`) covers `src/**/*.ts` and a list of leaf JS modules, shared types live in `src/search/types.ts`, and `npm run typecheck` runs inside `npm run check`. The code is still CommonJS.*

- Type-check command exists but does not require a full rewrite.
- Core result/corpus/embedding types are documented.
- At least one leaf module has type checking enabled with no behavior change.

## Track 2: Frontend modularization

### Goal

Improve readability of the framework-free frontend while preserving the no-build-tool deployment path.

### Preferred approach

1. **Inventory `public/app.js` responsibilities.**
   - Search API client
   - Result rendering
   - Dictionary tooltip/popover behavior
   - Script-mode toggle
   - Saved idioms/bookmark state
   - Anki export
2. **Extract browser modules without adding a bundler.**
   - Use plain ES modules if browser support/deployment constraints are acceptable.
   - Otherwise split into small scripts loaded in order and covered by existing VM-based tests.
3. **Prioritize pure helpers first.**
   - Script conversion/render helpers
   - Anki TSV serialization
   - Result-card view-model formatting
   - Saved idiom storage adapters
4. **Keep interaction tests close to behavior.**
   - Existing frontend tests are valuable because they assert real DOM output and export shape.

### Guardrails

- No React/Vue/Svelte migration in this phase.
- No build tool until the app has clearer browser module seams.
- Preserve the current static hosting model.
- Keep public export runnable without a compile step.

### Done criteria for first phase

*Met 2026-06-23: utilities, API client, storage, Anki export, bookmarks, speech and the dictionary controller were extracted into `public/frontend-*.js` plain scripts, still with no build step, covered by the existing frontend tests.*

- `public/app.js` has at least one extracted pure module/helper file.
- Existing frontend tests cover the extracted behavior.
- The deployed static page still works without a build.

## Track 3: Artifact and data cleanup

### Goal

Make large/generated data easier to understand and maintain without breaking semantic search or the public export.

### Preferred approach

1. **Classify artifacts by source of truth.**
   - Runtime source: `chengyuData.js`, `embeddings-local.bin`, `public/generated/*`. *(Since 2026-10 also the int8 Qwen indexes `embeddings-qwen-i8.bin` and `embeddings-qwen-situations-i8.bin`, and since 2026-11 `data/variant-families.json`.)*
   - Readable/runtime fallback: `embeddings-local.json`.
   - Source inputs: CC-CEDICT files and overrides.
   - Generated/private logs: old embedding regeneration logs and scratch outputs.
2. **Document regeneration commands.**
   - Dictionary subset: `npm run dictionary:build`.
   - Binary embeddings: `node scripts/convert-embeddings-binary.js --input embeddings-local.json --output embeddings-local.bin`.
   - Embedding generation: keep benchmark/generation commands explicit and model-tagged.
3. **Reduce repository noise safely.**
   - Move obsolete logs/backups to ignored local storage or delete after confirming they are not referenced.
   - Keep binary and JSON embeddings synchronized until a deliberate public-export decision changes that.
4. **Protect embedding-space correctness.**
   - Never compare vectors across incompatible models/templates/pooling/normalization settings.
   - Keep metadata validation fatal for mismatched artifacts.

### Guardrails

- Do not remove `embeddings-local.json` from the public/full export until the lite/full policy is revisited.
- Do not delete data sources without a regeneration path and attribution note.
- Run public-export tests after any allowlist or artifact layout change.

### Done criteria for first phase

- A data/artifact inventory doc exists.
- Stale logs/backups are either ignored, moved out of the repo, or explicitly retained with a reason.
- Public export still passes its generated-copy test suite.

## Suggested sequencing

1. Add a lightweight type-check experiment for one leaf module. *(Done 2026-06.)*
2. Extract one pure frontend helper with tests. *(Done 2026-06.)*
3. Write an artifact inventory and clean only clearly obsolete local logs/backups.
4. Reassess whether TypeScript, frontend modules, or artifact cleanup has the highest next payoff.

Each step should remain separately commit-able, autoreviewed, and verified with `npm run check` when behavior can be affected.

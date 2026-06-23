# Engineering Roadmap

This document captures the next larger refactor tracks after the `src/` architecture split. These are intentionally paced separately from the search-quality work so production behavior stays benchmark-backed.

## Current baseline

- Production runtime modules live under `src/server`, `src/search`, `src/embeddings`, and `src/data`.
- `api-server.js` is a lifecycle/composition entrypoint with an explicit `createApp()` boundary.
- `npm run check` is the local gate: unit/regression tests plus relevance benchmark thresholds.
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

- `public/app.js` has at least one extracted pure module/helper file.
- Existing frontend tests cover the extracted behavior.
- The deployed static page still works without a build.

## Track 3: Artifact and data cleanup

### Goal

Make large/generated data easier to understand and maintain without breaking semantic search or the public export.

### Preferred approach

1. **Classify artifacts by source of truth.**
   - Runtime source: `chengyuData.js`, `embeddings-local.bin`, `public/generated/*`.
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

1. Add a lightweight type-check experiment for one leaf module.
2. Extract one pure frontend helper with tests.
3. Write an artifact inventory and clean only clearly obsolete local logs/backups.
4. Reassess whether TypeScript, frontend modules, or artifact cleanup has the highest next payoff.

Each step should remain separately commit-able, autoreviewed, and verified with `npm run check` when behavior can be affected.

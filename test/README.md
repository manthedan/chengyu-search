# Search Quality Tests

Automated tests to ensure multilingual search quality remains high as the codebase evolves.

## Running Tests

The test suite starts the API server automatically on an ephemeral port:

```bash
npm test
```

## Test Coverage

### English Keyword Search Quality
- Verifies "fart" ranks 狗屁不通 in top 3
- Ensures idioms about making things worse are found

### Chinese Character Search
- Exact match: "狗屁不通" → 狗屁不通 (first result)
- Partial match: "狗屁" → finds 狗屁不通
- Single character: "龙" → finds dragon idioms

### Pinyin Search
- Numbered pinyin: "gou3 pi4" finds relevant idioms
- Accented pinyin: "gǒu pì" normalizes and finds results

### Semantic Search Quality
- Finds conceptually related idioms (e.g., "fart" → smell/nonsense idioms)
- Understands abstract concepts (e.g., "opportunity" → timing/chance idioms)

### Smart Routing
- English queries prioritize English fields (meaning, literal)
- Chinese queries prioritize Chinese fields (chengyu, pinyin)

### Auto Routing
- Verifies English description queries auto-route to semantic search
- Verifies Chinese and pinyin queries auto-route to hybrid search

### Curated Hybrid Examples
- Tracks the exact example chips shown in the UI
- Verifies they return strong top hybrid results

### Ranking Quality
- Results ordered by relevance
- Returns max 10 results

### Edge Cases
- Empty queries return 400 error
- Mixed language queries work
- Very long queries handled gracefully

## Adding New Tests

When adding features or modifying search behavior:

1. Add test case to `search-quality.test.js`
2. Run `npm test` to verify
3. Update this README if needed

## CI/CD Integration

The tests are CI-friendly because they boot the API server themselves:

```bash
npm ci
npm test
```

## Benchmarking

For formal offline benchmarking, use the scripts in `benchmark/`:

```bash
npm run benchmark:relevance
npm run benchmark:modes
npm run benchmark:latency
npm run benchmark:holdout
npm run benchmark:embeddings
npm run benchmark:weights
```

Key regression benchmarks tracked by the test suite:
- "fart" query: 狗屁不通 must be in top 3 (keyword search)
- Chinese exact match: must be first result
- Single char search: all results must contain the character
- Accented pinyin: must normalize and find matches
- Auto-routed search: English description queries should use semantic; Chinese/pinyin should use hybrid
- Curated hybrid example chips: must return their intended top idioms

If any of these fail, search quality has regressed.

# Compact Chinese normalizer

Promoted byte-for-byte from `zh-search` commit `3ba7c1b`: `normalize.js`, `compact-table.js`, `normalizer-data.bin`, and the provenance manifest. Runtime loads the 1,593,432-byte compiled artifact lazily; no compiler, OpenCC package, full dictionary JSON or experiment module is required.

Private builds can reproduce promotion with `node scripts/sync-chinese-normalizer.js`. The source branch's final review was still in progress at promotion; subsequent fixes must be merged and re-promoted explicitly. Serving adds corpus-owned exact headword aliases in `../chinese-query.js`; those override general normalization only for complete served headwords.

The manifest records the compiled source and binary hashes and the OpenCC/CC-CEDICT source licenses. See root `NOTICE.md`, `DATA_LICENSE.md`, and `OPENCC-LICENSE.txt`.

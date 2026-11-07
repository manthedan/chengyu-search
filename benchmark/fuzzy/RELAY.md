# Fuzzy matcher relay

Goal: replace fuse.js in `src/search/fuzzy-matcher.js` with a purpose-built
matcher that is faster and smaller, **with rankings frozen**. Agents take turns
(Opus, then Codex gpt-6.1-sol, and so on). Each turn makes one focused
improvement and records it in the log below.

## Why

On production, fuse.js adds roughly 0.3–1.7 s to pinyin, short-Chinese and
keyword searches. It scans all 7,348 entries character by character (Bitap)
across six weighted fields, including long `example` sentences, and the scan
blocks the Node event loop. English and long Chinese descriptions go to hosted
embeddings and do not use this code.

## Contract: rankings are frozen

`src/search/fuzzy-matcher.js` must keep returning exactly what fuse.js 7.1
returns for the three option profiles search-logic uses (English keys and
Chinese keys over the corpus, and `pinyin_norm` over the pinyin list): the same
items, in the same order, with bit-identical scores, at every limit. This is
checked against a frozen oracle of real fuse.js output:

    node --test test/fuzzy-parity.test.js      # must pass: 0 mismatches
    node --test test/fuzzy-e2e.test.js         # end-to-end keyword rankings

Only the behavior search-logic actually uses needs to be supported: `keys` with
weights, `threshold`, `minMatchCharLength`, `ignoreLocation: true`, scores
always included, and `search(query, { limit })`. Extended search, logical
queries, `includeMatches`, `useExtendedSearch` and similar options are not used.

Fuse.js 7.1 source is available for reference in `node_modules/fuse.js/dist/`.

## Rules

- **Files you may change:** `src/search/fuzzy-matcher.js`, any new files under
  `src/search/fuzzy/`, new unit tests under `test/` (named `fuzzy-*.test.js`),
  and the log section of this file.
- **From round 2 on, also `src/search/search-logic.js`, for speed only.** Its
  rankings are frozen end to end by `test/fuzzy-e2e.test.js`: 702 cases of
  `keywordSearchOnly()` output (every query and lexical variant, default and
  51-row windows) recorded with fuse.js as the matcher. Results must be deep
  equal, including which object each `item` is. Keep search-logic changes
  small and local (caching, avoiding repeated work); do not restructure it.
- **Frozen harness:** do not modify `benchmark/fuzzy/*.js`, `queries.json`,
  `oracle.json`, `e2e-oracle.json`, `test/fuzzy-parity.test.js`,
  `test/fuzzy-e2e.test.js`, or `src/search/search-config.js`.
- Do not commit. Leave your changes in the working tree; the coordinator
  verifies the scoreboard independently and commits each kept round.
- A change is **kept** only if:
  1. the parity test and the end-to-end test both pass,
  2. it improves at least one metric beyond noise,
  3. `runtime.all.p95` and `runtime.totalMs` do not regress by more than 5%,
  4. `cold.indexMemoryMb` (V8 heap plus typed-array backing stores) stays at
     or below 40 MB, about fuse.js + 20 MB. Production runs in 512 MB with
     embeddings loaded. `indexHeapMb` alone misses `Int32Array` memory.
  5. `npm test` shows no new failures. 5 tests fail on `main` already; they are
     unrelated, so compare against that list.
- If your idea does not pan out, revert it and log what you learned. A
  well-documented dead end is a useful turn.
- Prefer clear, small code. Fewer lines and fewer files loaded is a metric.

## Commands

    node --test test/fuzzy-parity.test.js test/fuzzy-e2e.test.js   # ~10 s
    node benchmark/fuzzy/scoreboard.js --passes 3        # JSON scoreboard
    npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖ "   # full suite

Metrics, in order of priority for this relay:

1. Runtime: `runtime.all.p95`, `runtime.totalMs`, and `runtime.byGroup.*.p95`
   (warm, end-to-end `keywordSearchOnly` per query).
2. Cold start: `cold.firstQueryMs.*` (includes index build in a fresh process).
3. Footprint: `footprint.fuzzyCodeBytes` (code loaded for fuzzy matching), the
   `fuse.js` production dependency, and `cold.indexHeapMb`.

## Log

Each turn appends: who, what was tried, kept or reverted, scoreboard deltas
against the previous best, and notes for the next agent.

### Baseline (fuse.js 7.1 behind the matcher boundary)

Coordinator, 2026-11-05. Full scoreboard: `benchmark/fuzzy/baseline-fuse.json`
(`--passes 2`, Apple Silicon, Node 25.9). Parity test passes against the oracle
(450 calls × 4 limits) but takes about 10 minutes with fuse.js itself.

| Metric | Fuse 7.1 |
| --- | --- |
| runtime.all p50 / p95 / max | 279 / 1455 / 2808 ms |
| runtime.totalMs (333 queries) | 125,765 ms |
| byGroup p95: labeled / pinyin / chinese / english | 1850 / 599 / 29 / 1455 ms |
| cold firstQueryMs: english / pinyin / chinese | 454 / 292 / 38 ms |
| cold matcherRequireMs | 5.1 ms |
| cold indexHeapMb | 17.2 MB |
| fuzzyCodeBytes | 68,463 (fuzzy-matcher.js + fuse.cjs) |
| production deps | @xenova/transformers, cors, express, fuse.js |

Oracle shape: 450 calls. Profile 0 (English keys over the corpus): 319 calls.
Profile 1 (`pinyin_norm`): 86. Profile 2 (Chinese keys): 45. 128 calls return
nothing, 21 hit the 102 limit, and 118 contain tied scores, so tie order
(Fuse sorts by score, then `refIndex`) matters.

### Round 1: Opus, own matcher replaces fuse.js (kept, pending coordinator check)

**What changed.** `src/search/fuzzy-matcher.js` is now a self-contained
matcher (about 200 lines, no dependencies). `fuse.js` moved to
`devDependencies`. New `test/fuzzy-matcher.test.js` runs a randomized
differential test against fuse.js: small alphabets with uppercase, `é`, `画`
and spaces; blank, numeric, null and nested-array fields; queries up to 75
characters; thresholds 0.2/0.24/0.4; and `minMatchCharLength` 1/2/3. It runs
in about 1.5 s. Parity: 0 mismatches out of 1800 checks, and the parity test
now takes about 5 s instead of about 10 min.

How it stays exact, with ignoreLocation:
- A chunk scores `max(0.001, e / m)`. Here `e` is the lowest Bitap error level
  that finds the chunk anywhere in the text. Fuse's Bitap is Wu-Manber, so `e`
  equals the smallest Levenshtein distance between the chunk and any substring
  of the text. Myers' bit-parallel algorithm computes `e` in one pass per text.
- Fuse's `location`, `expectedLocation`, `indexOf` and bin-search code changes
  only which positions it scans after the first hit at a level, never the score
  or `isMatch`. That code can be dropped.
- Prefilters that cannot reject a Fuse match:
  1. Length: the text must be at least `m - maxErrors` characters long.
  2. Character signature: a 32-bit mask of `code & 31`. A text may lack at most
     `maxErrors` of the chunk's character positions.
  3. Pigeonhole: split the chunk into `maxErrors + 1` pieces. Any match leaves
     one piece intact, so all of that piece's trigrams must appear in a
     1024-bit trigram Bloom filter per text. This filter is skipped when any
     piece is shorter than 3 characters.
- Distinct lowercased texts are deduplicated across keys and records. Tags
  repeat a lot: 33k values reduce to 2.9k distinct texts. Norms are computed
  once per distinct text.

**Scoreboard** (`--passes 2`, same machine under load average ~4.5, so runtime
numbers are noisy):

| Metric | Fuse 7.1 | Round 1 |
| --- | --- | --- |
| runtime.all p50 / p95 / max | 279 / 1455 / 2808 ms | 7.5 / 15.2 / 37.8 ms |
| runtime.totalMs | 125,765 ms | 2,574 ms |
| byGroup p95: labeled / pinyin / chinese / english | 1850 / 599 / 29 / 1455 ms | 24.0 / 10.0 / 1.8 / 13.3 ms |
| cold firstQueryMs: english / pinyin / chinese | 454 / 292 / 38 ms | 51.3 / 20.0 / 24.8 ms |
| cold matcherRequireMs | 5.1 ms | 1.2 ms |
| cold indexHeapMb | 17.2 MB | 15.2 MB |
| fuzzyCodeBytes | 68,463 | 10,275 (fuzzy-matcher.js only) |
| production deps | + fuse.js | @xenova/transformers, cors, express |

`npm test`: 295 tests, 290 pass, 5 fail. These are the same 5 that fail on
the baseline (config-loader ×2, enrichment-full-fix1, enrichment-round4 ×2). I
confirmed this by running those files with the original matcher. The 9 new
tests are fuzzy tests.

**Exactness traps found:**
- Key weights are **not** normalized in scoring. KeyStore divides by the total
  weight, but `_searchObjectList` scores with the index's own `createKey`
  copies, which keep the raw weights (0.42, 0.3, and so on). This was my only
  oracle mismatch, and it shifted every score.
- Array values (`tags`) are scored in **reverse** order because Fuse builds
  them with a stack and pops. The product `totalScore *= pow(...)` depends on
  order down to the last bit.
- A text equal to the whole lowercased query scores 0. It becomes
  `Number.EPSILON ** (weight * norm)` and skips chunking and
  `minMatchCharLength`.
- Queries over 32 characters are split into 32-character chunks, and the last
  chunk is `pattern.slice(len - 32)`, so it overlaps the one before. A text's
  score is the mean over all chunks, where a chunk that does not match adds 1.
  The text matches if any chunk matches.
- Error levels: level `i` runs only if `i === 0`, or if `i < m` and
  `i / m <= threshold`, compared in floating point. Matches above that level
  score 1 or do not count.
- `minMatchCharLength > 1` needs a run of that many consecutive text
  characters that each occur somewhere in the chunk. The run can be anywhere in
  the text, not only inside the match, because Fuse's mask marks every scanned
  position.
- The norm counts runs of non-space characters (ASCII space only) in the
  original text: `Math.round(1000 / sqrt(n)) / 1000`, with `parseFloat` as a
  no-op. Lowercasing never changes the count, so it can be cached per
  lowercased text.
- Top-level numbers and booleans are stringified. Inside arrays they are
  dropped.
- Sorting is by score, then `refIndex`. Distinct doubles never subtract to 0,
  so `a - b || ia - ib` is exact.

**Dead end:** native `indexOf`/`includes` as a pigeonhole prefilter is slower
than Myers. The corpus strings are two-byte (examples contain Chinese), and V8
scans them at about 0.9 ns per character per piece. Myers runs at about 3 ns
per character but covers all pieces in one pass. Use an index such as the
Bloom filter, not a scan.

**Notes for Codex (next rounds):**
1. **The end-to-end floor is now outside the matcher.** A CPU profile of
   `keywordSearchOnly` over the query set shows about 45% of the time in
   `normalizePinyin` and its regexes. These come from `getPinyinExactMatches`,
   which normalizes all 7,348 pinyin strings on every call, one to two calls
   per query, in the frozen `search-logic.js`. The matcher accounts for about
   47% (Myers 27%, scan loop 14%, Bloom 5%). If the coordinator allows a cached
   normalized-pinyin map (the pinyin index cache already builds `pinyinData`),
   runtime would roughly halve.
2. Matcher runtime ideas:
   - A 2048-bit Bloom filter was about 10% faster on profile 0 but adds about
     5 MB. Blooms for short texts are wasted, since the signature filter
     already rejects most tags and headwords.
   - An inverted trigram index would remove the per-text loop. Only about 11%
     of long texts pass the pigeonhole test.
   - In Myers, a run of at least `m` characters not in the chunk resets the
     state to its initial value. Skipping such runs would help with the Chinese
     half of `example`.
   - The 4-chunk queries (labeled group) repeat the whole scan per chunk.
3. Cold start and footprint:
   - Profiles 0 and 2 both index chengyu, pinyin, meaning and literal from the
     same corpus. A shared per-list text table and Bloom cache, for example a
     module `WeakMap` keyed by `list`, would cut build time and memory.
   - Index build is about 15 ms per corpus profile. The remaining cost is
     `toLowerCase`, the Map dedup and Bloom hashing.
4. `package-lock.json` still lists `fuse.js` under the root `dependencies`. The
   rules allow only `package.json`, so the coordinator should run
   `npm install --package-lock-only` before relying on `npm ci`.

Coordinator check of round 1: kept (commit 8cffa6f). Parity 0/1800; a separate
780-check random fuzz against fuse.js (fresh corpus snippets with edits, case
changes, lengths up to 70, all three profiles, limits 15 and 102) also found 0
differences. npm test shows the same 5 known failures. Independent scoreboard:
p50/p95 7.1/14.8 ms, totalMs 2503, byGroup p95 25.0/9.1/1.9/13.2 ms, cold
65/22/25 ms, heap 15.2 MB, 10,275 bytes. `package-lock.json` regenerated.

Coordinator, after round 1: added `test/fuzzy-e2e.test.js` and
`benchmark/fuzzy/e2e-oracle.json` (built by `build-e2e-oracle.js` with fuse.js)
so `search-logic.js` can now change for speed. Note: 172 cases contain items
that are not corpus objects (itemIndex -1; pinyin fuzzy hits return the
`pinyinData` copies). That is existing behavior and stays frozen.

### Round 2 (Codex): cached exact pinyin and faster candidate filtering

**Changes left for coordinator review.** In `search-logic.js`, the existing
corpus cache now builds an exact-pinyin map while normalizing `pinyinData`.
The map keeps arrays of the original corpus objects, in corpus order; fuzzy
pinyin hits still use the copies. Exact lookups no longer normalize and scan
all 7,348 entries on every query. Cache invalidation follows the existing
corpus-reference check.

After that change, a 12-pass `node --cpu-prof` run put 57% of samples in
Myers, 27% in the matcher search loop, and 9% in the Bloom test;
`normalizePinyin` was below 1%. The next kept change transposes the Bloom
index into bitsets of text IDs: intersect the trigram bitsets within each
pigeonhole piece, then union the pieces, testing 32 texts at a time. A
4096-bit filter reduces false positives further. Scoring and its accumulation
order are unchanged. Build the filter lazily, since short queries cannot use
it. Finally, when a chunk allows zero edits, native `includes` replaces Myers
exactly; this cuts short-Chinese scan time substantially.

**Scoreboard.** Both before and final runs used
`node benchmark/fuzzy/scoreboard.js --passes 3`, including parity. The fresh
before run measures the committed round 1 implementation on this machine.

| Metric | Round 1, fresh before | Round 2 | Delta |
| --- | --- | --- | --- |
| runtime.all p50 / p95 / max | 6.764 / 12.950 / 27.224 ms | 1.634 / 8.366 / 22.548 ms | p95 -35.4% |
| runtime.totalMs (333 queries) | 2,312 ms | 895 ms | -61.3% |
| byGroup p95: labeled | 18.777 ms | 11.165 ms | -40.5% |
| byGroup p95: pinyin | 9.250 ms | 3.107 ms | -66.4% |
| byGroup p95: chinese | 1.838 ms | 0.668 ms | -63.7% |
| byGroup p95: english | 12.202 ms | 8.366 ms | -31.4% |
| cold firstQueryMs: english / pinyin / chinese | 56.8 / 20.4 / 24.0 ms | 69.2 / 17.5 / 27.2 ms | mixed; see below |
| cold matcherRequireMs | 1.5 ms | 1.8 ms | +0.3 ms |
| cold indexHeapMb | 15.2 MB | 16.7 MB | +1.5 MB |
| fuzzyCodeBytes | 10,275 | 11,144 | +869 bytes |

Against the archived coordinator round 1 check (p95 14.8 ms, total 2,503 ms),
the final p95 is down 43.5% and total is down 64.2%. Production dependencies
are unchanged. Cold English and Chinese regressed in the single scoreboard
sample. A separate three-run alternating comparison using the original round
1 matcher **and search logic** versus the final code gave median cold times
of 81.5 / 27.8 / 34.4 ms versus 62.3 / 19.6 / 29.8 ms. Cold measurements drifted
considerably under shared load; do not treat those medians as a stable cold
win. The heap bound passes. Typed-array buffers are additional to `heapUsed`:
the paired cold check measured 11.0 MB before and 24.6 MB after in buffers.

**Validation.** The required parity and end-to-end tests pass: 0/1800 matcher
mismatches, and all 702 end-to-end cases retain their scores, ordering, and
item identity. Including `test/fuzzy-matcher.test.js`, all 13 fuzzy tests pass.
No frozen harness files were changed; no install or commit was performed.

`npm test` cannot meet the five-failure-only check inside this sandbox:
it reports 297 tests, 249 passes, 8 failures, and 40 cancellations. Besides
the five known failures, two embedding-stable-id HTTP fixtures and hosted-http
fail because `listen` is denied with `EPERM`; search-quality's HTTP setup
fails for the same reason and cancels its tests. Repeating the full suite
with the original round 1 versions of both changed source files (loaded via
a temporary preload, without changing any test) produced identical counts
and all 59 identical failure/cancellation locations. There are no new
failures relative to that control, but the coordinator still needs the full
suite outside the restricted sandbox before declaring this round kept.

**Experiments reverted / not selected.**
- Skipping non-pattern characters while Myers is at its initial distance
  was exact (including 100,000 checks against independent dynamic programming)
  but slowed an alternating end-to-end comparison by about 22%. Reverted.
- Returning early from Myers at distance zero alone had no measurable total
  benefit. Reverted along with the skip branch.
- A conventional 2048-bit Bloom filter helped about 5% in an alternating
  comparison, but transposing the original 1024-bit filter helped about 17%.
  Comparing transposed 1024/2048/4096-bit variants favored 4096 for runtime;
  it costs more buffer memory. Only the 4096-bit transposed version remains.

**Notes for the next agent.**
- Exact pinyin is no longer the runtime floor. Profile the remaining matcher
  work; the final 12-pass CPU profile attributes about 47% to Myers, 43% to
  the search loop, and 3% to candidate bitsets. Long labeled/English queries
  still dominate p95. The zero-edit
  `includes` path is different from round 1's unsuccessful pigeonhole scans:
  it directly answers the whole chunk's exact-match question.
- The wider filter consumes four times the old Bloom buffer when built;
  `cold.indexHeapMb` does not count that memory. Consider 2048 bits if memory
  becomes more important than pinyin latency, and check `arrayBuffers` too.
- Cold corpus-profile construction still repeats lowercasing, deduplication,
  signatures and norms for English and Chinese. Sharing immutable field
  metadata may be the next cold-start improvement; preserve each profile's
  own searchable text set and the frozen scoring order.
- Measurement JSON, comparison scripts and CPU profiles were kept in `/tmp`
  under `fuzzy-round2-*`; the working tree contains only the two source edits
  and this log from this round. The pre-existing dirty
  `node_modules/.package-lock.json` was left untouched.

Coordinator check of round 2: kept, with one change. Codex's transposed
trigram index used 4096 hash bits, which costs 38.7 MB of `ArrayBuffer`
memory once every profile is built (round 1: 11.0 MB). The scoreboard's
`indexHeapMb` did not count it, so the scoreboard now also reports
`cold.indexMemoryMb` and rule 4 uses that. Measured with all profiles built
(heap + array buffers): fuse.js about 20 MB, round 1 26 MB, round 2 at 4096
bits 56 MB. Sweep, 3 passes each:

| GRAM_BITS | array buffers | p50 / p95 | totalMs |
| --- | --- | --- | --- |
| 4096 | 38.7 MB | 1.34 / 7.18 ms | 771 |
| 2048 | 20.3 MB | 1.48 / 6.76 ms | 750 |
| 1024 | 11.1 MB | 2.18 / 8.25 ms | 1031 |

Kept 2048. Parity, end-to-end and matcher tests pass, and a fresh 520-check
fuzz against fuse.js finds no differences. npm test shows the same 5 known
failures (297 tests). Codex's sandbox blocks HTTP fixtures, so its npm test
run shows extra EPERM failures that are not real. The coordinator reruns
npm test outside the sandbox. Cold first query is noisy at about 55/18/26 ms,
and the lazy index build now lands on the first long query, which is a target
for the cold-start leg.

### Round 3 (Opus): one shared text table per list, eager fused trigram build, lazy pinyin copies

Leg: cold start and memory, keeping warm runtime. Kept, pending coordinator check.

**Where the time and memory went** (round 2 as committed, 2048 bits; cold
script equal to the scoreboard's, CPU profiles aggregated over 5–10 fresh runs):
- The English build (about 28 ms on its own) split into fieldValues (about 5 ms),
  `toLowerCase` (about 5), the Map dedup (8–10), and the signature/token loop
  (about 8). The lazy trigram build then added about 13 ms to the first long
  query. The Chinese profile repeated most of that work (10–20 ms) on a subset of
  the same texts: 28,882 of its texts are also English-profile texts.
- Memory: the English profile used 7.1 MB of heap and 9.6 MB of trigram buffers;
  the Chinese profile used 3.3 MB of heap, plus 7.4 MB of trigrams once a long
  Chinese query arrives; the `pinyinData` copies used 1.75 MB. About 4.5 MB
  (heap 2.75 + buffers 1.8) is `headwordIndex` and the normalize table in
  `src/data/chinese-query.js`, outside the allowed files.
- `toLowerCase` copies two-byte strings even when nothing changes. 30,388 of
  the 39,146 English-profile texts are already lowercase.

**What changed.**
- `fuzzy-matcher.js`: a module `WeakMap` maps each list to one table of distinct
  lowercased texts with their signatures, norms and transposed trigram bitsets.
  It also caches each key's values as text IDs (`start`/`values` Int32Arrays), so
  a later matcher over the same list reuses keys that are already indexed. The
  Chinese profile now builds in about 0.5 ms, needs no new texts, and shares the
  English trigram index. Each matcher scans only its own distinct texts (`scan`).
  The text-to-ID Map is dropped after each build and rebuilt from `texts` only
  if a later matcher adds a key.
- The signature, norm and trigram work is one fused pass per new text, run once
  per matcher build and no longer lazily. If a later matcher adds texts, the
  existing bitset rows are re-laid out. An earlier version that indexed after
  each key re-laid out 10 MB six times and was slower.
- If lowercasing changes nothing, the table keeps the corpus string. This and
  the next item cut English-profile heap from 7.1 to 3.5 MB.
- Per-record values and exponents are exact-size typed arrays. Plain `for` loops
  replace `forEach`/`for…of` in the build: about 3 ms on the build (min and
  median over 21 alternating runs).
- `search-logic.js`: the pinyin matcher indexes `{ pinyin_norm }` objects. The
  `{ ...entry, pinyin_norm }` copies that fuzzy pinyin hits return are made on
  first hit and cached, so they are the same objects with the same content as
  before. `normalizePinyin` uses 3 regex passes instead of 5: the two deletions
  commute, and `[^a-z\s]` → space followed by `\s+` → space equals `[^a-z]+` →
  space. Old and new versions agree on 329,297 inputs: every corpus string, the
  query set, and random Unicode, space, digit and combining-mark strings. The
  saving is small, about 12% of a corpus pass.
- `test/fuzzy-matcher.test.js`: a new case builds matchers with growing key
  subsets over one list, and queries them interleaved against fuse.js. This
  exercises table reuse, growth and row relayout.

**Validation.** Parity 0/1800, all 702 e2e cases pass, and all 14 fuzzy tests
pass. Parity also holds (0/1800 each) with the profiles built in reverse order
(zh and pinyin first, so the English build grows the table) and after a
key-subset matcher is built over a fresh copy of the list. The full
`keywordSearchOnly` JSON output, with whole items in key order, matches round 2
byte for byte on 1,332 cases (every query and lexical variant, default and
51-row windows). `npm test`: 298 tests, only the 5 known failures
(config-loader ×2, enrichment-full-fix1, enrichment-round4 ×2).

**Scoreboard.** `--passes 3`, load average 5–8, so warm numbers move about 25%
between runs. The fair comparison is three interleaved scoreboard pairs, with
round 2 run from a copy of the committed `src` (medians):

| Metric | Round 2 (committed, 2048 bits) | Round 3 | Delta |
| --- | --- | --- | --- |
| runtime.all p50 / p95 | 1.81 / 8.77 ms | 1.88 / 8.72 ms | p95 −0.6% |
| runtime.totalMs | 948 | 983 | +3.7% (see below) |
| cold firstQueryMs english / pinyin / chinese | 62.4 / 19.1 / 30.8 ms | 60.8 / 10.1 / 14.9 ms | −3% / −47% / −52% |
| cold.indexMemoryMb (scoreboard) | 29.9 MB | 23.7 MB | −6.2 MB |
| cold.indexHeapMb | 16.7 MB | 8.4 MB | −8.3 MB |
| every profile built, heap + buffers | 37.1 MB | 23.7 MB | −13.4 MB (fuse.js about 20) |
| fuzzyCodeBytes | 11,144 | 12,777 | +1,633 |

Separate runs at my start and end (not interleaved) gave a before of 1.82 /
8.45 / 963 with cold medians of 63.4 / 17.4 / 27.1, and an after of 1.74 / 7.97 /
892 with 61.8 / 11.2 / 14.4. On totalMs: a dedicated warm A/B (5 alternating
processes, 5 passes over the query set) gave round 3 about 650 ms and round 2
about 673. I see no warm regression; the +3.7% is within noise and under the
5% bound.

English cold is about flat. Building the trigrams eagerly moved about 13 ms
from the first query into the build, and the fused pass and loop changes
recovered only part of it. Pinyin and Chinese now find their indexes mostly
built or shared.

**Dead ends (reverted).**
- Reusing module-level `total`/`hit` buffers across queries made no measurable
  difference warm, and holds about 0.35 MB permanently.
- A 512-bit trigram space for short-text tables (the pinyin list, about 15
  characters per text) saves 1.3 MB of buffers and stays exact, since any hash
  is a valid conservative filter. Pinyin-group runtime was inconclusive under
  load: 2 of 4 runs were equal and 2 were slower.
- Keying the dedup Map by the raw value (lowercasing only first-seen strings) is
  exact and adds only 3 case-variant texts, but saved just 1–2 ms. Not kept.
- A rolling version of the same trigram hash (carrying
  `imul(imul(a, K1) ^ b, K2)` forward) makes the indexing pass about 8% faster
  in isolation, about 1 ms. Not kept, for clarity.
- A single-pass loop `normalizePinyin` is about 1.5× faster warm, but its cold
  first pass is about the same as the regexes. Not worth the rewrite.

**Notes for Codex.**
- English cold now goes to the English build itself. Per fresh run:
  `keyValues` about 10 ms (`toLowerCase` 4, Map get/set 5, fieldValues 1.5),
  `indexTexts` 10–15 ms over 1.82 M characters, the first search about 8 ms
  (JIT; about 4 ms warm), and `getFuseIndexCache` about 4 ms (`normalizePinyin`
  over the corpus). Most of this is one-shot code running in the lower JIT
  tiers. Fewer operations per character or value is what helps.
- Remaining memory in the scoreboard: English trigrams 9.6 MB, pinyin trigrams
  1.8 MB, `chinese-query.js` about 4.5 MB (not ours), the lowercased copies of
  the 8,758 texts that lowercasing changes (about 2 MB, mostly two-byte example
  sentences), the per-key and per-profile typed arrays about 1.5 MB, and
  signatures and norms about 0.7 MB.
- Ideas not tried:
  - Drop `exponents` and compute `weight * norms[t]` at match time (the same
    double, so exact). That saves about 0.8 MB but needs a per-value key index
    in the record loop.
  - Size the trigram space per table.
  - Case-fold through `peq` to avoid the lowercased copies. This is hard:
    lowercasing is context-sensitive (final sigma, `İ`), and the `includes`
    and `texts[t] === pattern` paths need lowercased text.
- Lists are now assumed immutable after a matcher is built. A later matcher
  reuses cached per-key IDs. search-logic's caches already assume this by
  reference.

Coordinator check of round 3: kept. Parity, end-to-end and matcher tests pass
(14). A fresh 624-check fuzz against fuse.js finds no differences. npm test:
298 tests, same 5 known failures. I reviewed the `normalizePinyin` rewrite and
it is equivalent: digits and combining marks are dropped in one pass, and any
run of non-letters, whitespace included, becomes one space. Three scoreboard
runs, `--passes 3`, load average about 5: p50/p95 1.2–1.3/5.4–6.4 ms, totalMs
598–695, cold 33/6/9 ms, indexMemoryMb 23.7, 12,777 bytes. Shared-table
assumption accepted: corpus lists are never mutated after load.

### Round 4 (Codex): smaller matcher, measured shortcuts, limit parity

**Kept for coordinator review.** Removed the length prefilter: its extra
branch and signature-loop guard did not earn a consistent end-to-end win.
The trigram setup now checks that every piece can contain a trigram before
allocating piece arrays, replacing the later `every()` check. Fields use named
`weight`/`offsets`/`values` properties instead of nested tuples; record offsets,
text IDs and signature-bit counts have explicit names. The shorter header
explains Myers/Bitap equivalence, both remaining conservative filters, zero-edit
substring search, chunking, the minimum-run gate and exact score accumulation.
`search-logic.js` is unchanged.

**Removal experiments.** Each variant removed one path from the committed
round 3 matcher and ran three scoreboards with `--passes 3 --skip-parity`,
alternating traversal order around a control. Medians below are milliseconds;
these runs drifted substantially with shared-machine load.

| Variant | warm p95 | totalMs | Chinese p95 | Decision |
| --- | --- | --- | --- | --- |
| Round 3 control | 6.149 | 686 | 0.509 | reference |
| No length prefilter | 5.999 | 661 | 0.463 | removed |
| No character signature | 6.631 | 696 | 0.464 | retained: p95 +7.8% |
| No trigram filter | 13.257 | 1,882 | 0.446 | retained: total +174% |
| No zero-edit substring shortcut | 6.908 | 767 | 1.803 | retained: Chinese p95 3.5x |

Removing incremental shared-table growth was also measured: rebuilding all
metadata instead of copying existing bitset rows has no useful warm effect,
but seven alternating fresh-process builds, Chinese profile before English,
took median 28.4 ms versus 25.8 ms with incremental growth. Memory was equal.
The growth path stays, including its interleaved-matcher differential test.

An isolated nine-pass matcher sweep suggested a roughly 3% cost for removing
the length bound. A subsequent three-pair end-to-end comparison of the final
candidate with/without that bound gave p95 5.570/5.642 ms and total 622/621 ms;
there is no consistent benefit to justify it. In that same comparison the
round 3 control versus final candidate was p50 1.206/1.205, p95 5.610/5.642
(+0.6%), total 622/621 (-0.2%). Warm performance is effectively unchanged.

**Other simplification rejected.** Scoring directly from the per-key arrays
eliminates the per-record text-ID/exponent copies and saves about 0.9 MB.
Three alternating scoreboard sets gave 632 ms total for round 3, 673 ms when
scoring one field at a time, and 722 ms with nested record/field loops. Both
exceeded the 5% budget, so the flat record layout and cached exponents stay.

**Before/after scoreboard.** Three complete runs before editing and three
complete runs after, each `node benchmark/fuzzy/scoreboard.js --passes 3`
(parity included); medians of each metric:

| Metric | Round 3 before | Round 4 after |
| --- | --- | --- |
| runtime.all p50 / p95 / max | 1.289 / 5.944 / 16.378 ms | 1.132 / 5.246 / 14.259 ms |
| runtime.totalMs (333 queries) | 666 ms | 580 ms |
| byGroup p95: labeled / pinyin / Chinese / English | 8.192 / 2.335 / 0.469 / 5.707 ms | 6.619 / 2.053 / 0.414 / 5.034 ms |
| cold firstQueryMs: English / pinyin / Chinese | 37.8 / 6.7 / 9.4 ms | 33.5 / 4.8 / 9.2 ms |
| cold matcherRequireMs | 1.4 ms | 1.0 ms |
| cold indexHeapMb / indexMemoryMb | 8.4 / 23.7 MB | 8.4 / 23.7 MB |
| fuzzyCodeBytes | 12,777 | 11,526 (-9.8%) |
| matcher line count (`wc -l`) | 254 | 234 (-7.9%) |

The apparent speed gains in separate before/after runs reflect machine noise;
the adjacent controls above support flat warm performance. Footprint is the
measured improvement. Temporary variants, scripts and raw scoreboards are in
`/tmp/fuzzy-round4/`, outside the working tree.

**Edge fixes and validation.** Limit 0 now returns `[]`; limits -1 and below
remain unlimited. Fuse's numeric-only `limit > -1` slicing also fixes negative
fractions between -1 and 0 and numeric-string limits. New differential cases
cover these, empty lists, empty/whitespace-only queries (without trimming),
Unicode casing/surrogates, and lengths 31/32/33/63/64/65/96/97, including exact
and partial chunks. The random suite still performs 360 searches, adding -1
to its limit choices; the new edge matrix is small. Matcher tests take about
1.7 s, and the complete required fuzzy command about 3.2 s.

`node --test test/fuzzy-parity.test.js test/fuzzy-e2e.test.js test/fuzzy-matcher.test.js`:
16 pass, 0 fail, including 0/1800 frozen matcher mismatches and all 702 frozen
end-to-end cases. Search unit checks (`hybrid-fusion`, `api-cache-key`,
`persistent-identity`, `served-headwords`) also pass: 10/10. No full `npm test`
or HTTP-fixture run, per the round's sandbox instructions; the coordinator
runs those. No frozen harness changes, install or commit.

Coordinator check of round 4: kept. Parity, end-to-end and matcher tests pass
(16). A fresh 624-check fuzz finds no differences. npm test: 300 tests, same 5
known failures. Interleaved A/B against round 3 (3 pairs, `--passes 3`):
totalMs medians 646 (round 3) and 663 (round 4), p95 5.65 and 6.02 ms, with
round 4 faster in one pair. That is within the noise of this machine. Cold
and memory are unchanged. Limit handling now matches fuse.js: 0 returns
nothing, negative or NaN returns everything.

Coordinator, after Codex review: the oracles store exact score bits, and on
Node 18 and 22 `Math.pow` rounds 79 recorded calls differently in the last
bit (at most 3.6e-16 relative). fuse.js and the matcher still agree bit for
bit on those runtimes, and no order changes. Both oracles now record the
runtime that generated them. Scores must be identical on that V8 and within
1e-12 relative elsewhere; order and items are always exact. The fuzzy tests
pass on Node 18.20.8, 22.23.4, 24.22.1 and 25.9.0.

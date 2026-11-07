# Release relevance gate

`npm run check` evaluates production `/api/search` with the unchanged original
`datasets/relevance.json` plus `datasets/relevance-supplement.json`. It prints the
original-only scores for reference and gates the combined-label **overall and
primary NDCG@5**, each against GitLab main `970559f908bd1d9a282bcd5bfd39c5198a0dfd89`
scored with exactly the same combined labels. Primary means `english_meaning`
and `thematic`. Linear gains, query membership, ranking requests, and averaging
are unchanged. Scores are compared before rounding with an absolute `1e-12`
tolerance, solely for floating-point noise.

The blind supplement uses `deepseek-v4-pro`, thinking disabled, temperature 0,
4096 maximum output tokens, and the same frozen dictionary context and judge
prompt as the release investigation. It never regrades an original pair.
The predeclared raw grade mapping is **0 → 0, 1 → 1.5, 2 → 3**. The file records
the model, prompt and dictionary hashes, completion date, mapping, reasons,
pair keys, source runs and source hashes. Explicit zero grades are labels.

**Every returned top-five slot must be labeled (100% coverage)** for both the
candidate and live baseline. Coverage counts returned slots rather than padding
short result lists. Missing queries, request errors and duplicate queries fail.
An unlabeled result fails with `needs judging`, the missing pairs and the
maintainer command; it cannot silently contribute a zero to a passing gate.
Neither `check` nor the offline gate tests call a paid API or read credentials.

The live baseline in `datasets/relevance-baseline.json` stores all 82 default
request top-ten rankings, unrounded overall/primary values, coverage, original
and supplement hashes, and derivation. The original-only baseline is also
recorded. The baseline is recalculated and checked when the gate runs; stale
label hashes, metrics or policy fail. New supplemental labels require deriving
the **same live revision** again, never weakening it to fit the candidate.

Maintainer workflow in the private experiment repository (requires the runtime
DeepSeek key in `~/.pi/agent/auth.json`; never print or copy credentials):

```sh
node experiments/corpus-v2/fix-round-2/judge.js --run --wait-offpeak --refresh-pool
node experiments/corpus-v2/fix-round-2/build-labels.js
npm run check
```

`--refresh-pool` retrieves the current production top-ten results and unions them
with the frozen main/before/after/fixed pool and every previously pooled pair,
then grades only uncached pairs. Labels remain cumulative when results leave
later rankings.
Dictionary contexts and the prompt remain frozen; unsupported headwords stop
with a missing-context error. The runner prints an estimate before dispatch and
uses peak-rate, byte-input/max-output reservations against its **$0.12 total
ledger cap**, including failed calls and retries. It waits through peak hours
with `--wait-offpeak`; exhausted budgets stop and require a separately authorized
follow-up, rather than resetting the ledger. The initial completion reused 459
previous labels and judged the 436 remaining pairs. No eval-sets test split is
used for serving changes.

To reproduce the baseline, archive `970559f` into an isolated directory with its
original corpus and embedding artifacts, link installed dependencies, and run:

```sh
CUDA_VISIBLE_DEVICES= QUIET_LOGS=1 node experiments/corpus-v2/fix-round-2/retrieve.js <archive-path> experiments/corpus-v2/fix-round-2/live-run.json
node experiments/corpus-v2/fix-round-2/build-labels.js
```

The checked-in live rankings exactly reproduce all 82 top-ten lists from the
independent gate investigation. Public exports include the gate, frozen labels
and baseline; paid judging remains a private maintainer workflow.

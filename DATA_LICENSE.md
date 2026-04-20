# Data license and attribution scope

This repository contains idiom data and derivative artifacts based on **CC-CEDICT**.

## Source dataset

- Source: **CC-CEDICT**
- Website: https://cc-cedict.org/
- License: **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**
- License text: https://creativecommons.org/licenses/by-sa/4.0/

## What this means here

The original code in this repository is licensed separately under MIT, but the idiom corpus and files derived from that corpus should be treated conservatively as **CC BY-SA 4.0** material.

That includes, at minimum, files such as:
- `chengyuData.js`
- `cedict-all-idioms.json`
- `cedict-chengyu-raw.json`
- `chengyu-4char.json`
- `embeddings-local.json`
- derivative benchmark/runtime artifacts that substantially encode the idiom corpus

When in doubt, if a file primarily republishes the idiom corpus or data derived from it, treat it as covered by this data notice rather than MIT alone.

## Modifications and enrichment

This project has modified and enriched the source material, including things like:
- cleaned / restructured dataset packaging
- refined literal glosses
- added usage notes
- added example sentences
- added tags / formality metadata
- generated embedding artifacts from the curated idiom records

Those modifications are distributed together with the derived data and should be treated consistently with the repository's CC-CEDICT-derived data notice.

## Redistribution guidance

If you redistribute the dataset or a public export built from it, you should preserve:
- attribution to CC-CEDICT
- a link to the CC BY-SA 4.0 license
- notice that the data was modified / enriched in this project
- the share-alike obligations applicable to the derived data

For a human-readable attribution notice, see `NOTICE.md`.

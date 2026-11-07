# NOTICE

This repository includes idiom data derived from **CC-CEDICT**.

Attribution:
- Source project: CC-CEDICT
- Source site: https://cc-cedict.org/
- Source license: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
- License URL: https://creativecommons.org/licenses/by-sa/4.0/

This repository contains modifications and enrichment on top of that source material, including curated packaging, refined translations/glosses, usage text, examples, labels, and derived embedding artifacts.

The repository's original code is licensed separately under MIT. See:
- `LICENSE`
- `DATA_LICENSE.md`

The compiled Chinese query-normalization data also incorporates **OpenCC 1.4.2** dictionary data (https://github.com/BYVoid/OpenCC), licensed under Apache License 2.0. The compiled representation adds CC-CEDICT identities and script mappings and shares suffix states; its source/artifact hashes and source-license declarations are recorded in `src/data/chinese-normalizer/normalizer-data.manifest.json`. The Apache license is included in `src/data/chinese-normalizer/OPENCC-LICENSE.txt`. CC-CEDICT-derived portions retain the CC BY-SA attribution above.

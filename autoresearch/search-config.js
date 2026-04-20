module.exports = {
  "fuseThreshold": 0.24,
  "pinyinFuseThreshold": 0.22,
  "minMatchCharLength": 1,
  "ignoreLocation": true,
  "chineseKeys": [
    {
      "name": "chengyu",
      "weight": 0.5
    },
    {
      "name": "pinyin",
      "weight": 0.3
    },
    {
      "name": "meaning",
      "weight": 0.15
    },
    {
      "name": "literal",
      "weight": 0.05
    }
  ],
  "englishKeys": [
    {
      "name": "meaning",
      "weight": 0.38
    },
    {
      "name": "literal",
      "weight": 0.28
    },
    {
      "name": "usage",
      "weight": 0.14
    },
    {
      "name": "example",
      "weight": 0.1
    },
    {
      "name": "chengyu",
      "weight": 0.1
    },
    {
      "name": "pinyin",
      "weight": 0.05
    },
    {
      "name": "tags",
      "weight": 0.2
    }
  ],
  "semanticMeaningWeight": 0.33,
  "semanticLiteralWeight": 0.2,
  "semanticUsageWeight": 0.12,
  "semanticExampleWeight": 0.08,
  "semanticTagWeight": 0.18,
  "literalOverlapWeight": 0.6,
  "literalBigramWeight": 0.45,
  "literalPhraseMatchBoost": 0.8,
  "semanticMultiGramWeight": 0.3,
  "semanticWeightedJaccardWeight": 0.36,
  "semanticDecomposeWeight": 0.22,
  "semanticFuzzyPrefixWeight": 0.06,
  "semanticFuzzyContainsWeight": 0.03,
  "exactPinyinBoost": 10,
  "keywordTopK": 20,
  "pinyinTopK": 15,
  "semanticTopK": 20,
  "embeddingWeight": 0.5,
  "tokenWeight": 0.5,
  "semanticWeight": 0.72,
  "keywordWeight": 0.28,
  "bothBoost": 1.7,
  "pinyinFuzzyBoost": 1.15,
  "typeOverrides": {
    "thematic": {
      "embeddingWeight": 0.65,
      "tokenWeight": 0.35,
      "semanticWeight": 0.85,
      "keywordWeight": 0.15,
      "semanticTagWeight": 0.45,
      "semanticConceptOverlapWeight": 0.5,
      "bothBoost": 2
    },
    "literal": {
      "embeddingWeight": 0.35,
      "tokenWeight": 0.65,
      "literalOverlapWeight": 0.7,
      "literalPhraseMatchBoost": 1
    },
    "english_meaning": {
      "embeddingWeight": 0.8,
      "tokenWeight": 0.2,
      "semanticWeight": 0.72,
      "keywordWeight": 0.28
    }
  }
};

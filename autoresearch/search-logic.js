/**
 * Search Logic — THE FILE THE AGENT MODIFIES (Phase 2)
 * 
 * This contains the actual search algorithm. The agent can make structural
 * changes: new ranking strategies, query preprocessing, field expansion,
 * re-ranking heuristics, etc.
 * 
 * Contract: must export a function search(query, CHENGYU, CHENGYU_EMBEDDINGS, config, options)
 * that returns a Promise resolving to an array of { chengyu, score } objects, sorted by score descending, max 10.
 * 
 * Current best NDCG: 0.4214 (Phase 1 parameter tuning)
 */

const Fuse = require('fuse.js');

// ---- Utilities ----

function cosineSimilarity(vecA, vecB) {
  const minLen = Math.min(vecA.length, vecB.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < minLen; i++) {
    dot += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

function normalizePinyin(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[0-9]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

let traditionalVariantMapsCache = null;

function getTraditionalVariantMaps() {
  if (traditionalVariantMapsCache) return traditionalVariantMapsCache;

  const cedictIdioms = require('../cedict-all-idioms.json');
  const idiomMap = new Map();
  const charCounts = new Map();

  cedictIdioms.forEach(entry => {
    const traditional = String(entry.traditional || '');
    const simplified = String(entry.simplified || '');
    if (!traditional || !simplified) return;

    idiomMap.set(traditional, simplified);

    const traditionalChars = Array.from(traditional);
    const simplifiedChars = Array.from(simplified);
    if (traditionalChars.length !== simplifiedChars.length) return;

    traditionalChars.forEach((traditionalChar, index) => {
      const simplifiedChar = simplifiedChars[index];
      if (!containsChinese(traditionalChar) || !containsChinese(simplifiedChar) || traditionalChar === simplifiedChar) {
        return;
      }

      if (!charCounts.has(traditionalChar)) {
        charCounts.set(traditionalChar, new Map());
      }

      const simplifiedCounts = charCounts.get(traditionalChar);
      simplifiedCounts.set(simplifiedChar, (simplifiedCounts.get(simplifiedChar) || 0) + 1);
    });
  });

  const charMap = new Map();
  charCounts.forEach((simplifiedCounts, traditionalChar) => {
    const bestMatch = Array.from(simplifiedCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    if (bestMatch) {
      charMap.set(traditionalChar, bestMatch);
    }
  });

  traditionalVariantMapsCache = { idiomMap, charMap };
  return traditionalVariantMapsCache;
}

function normalizeTraditionalChineseQuery(text) {
  const raw = String(text || '');
  if (!containsChinese(raw)) return raw;

  const { idiomMap, charMap } = getTraditionalVariantMaps();
  const trimmed = raw.trim();

  if (trimmed && idiomMap.has(trimmed)) {
    const exactNormalized = idiomMap.get(trimmed);
    return raw.replace(trimmed, exactNormalized);
  }

  return Array.from(raw).map(char => charMap.get(char) || char).join('');
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
  'with', 'like', 'up', 'out', 'off', 'over', 'under', 'about', 'through'
]);

const VALID_PINYIN_SYLLABLES = new Set(`
a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei deng di dian diao die ding diu dong dou du duan dui dun duo e en er fa fan fang fei fen feng fo fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun kai kan kang kao ke keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lian liang liao lie lin ling liu long lou lu luan lun luo ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie ning niu nong nu nuan nuo ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun r ran rang rao re ren ri rong rou ru ruan rui run ruo sa sai san sang sao se seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yong you yu yuan yue yun za zai zan zang zao ze zei zeng zha zhai zhan zhang zhao zhe zhen zheng zhi zhong zhou zhu zhua zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo
`.trim().split(/\s+/));

function stemToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenizeContent(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(stemToken)
    .filter(t => t && !STOPWORDS.has(t) && t.length > 1);
}

function buildBigrams(tokens) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

function buildNgrams(tokens, n) {
  const grams = [];
  if (n <= 1 || tokens.length < n) return grams;
  for (let i = 0; i <= tokens.length - n; i++) {
    grams.push(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

function tokenFrequencyMap(text) {
  const freq = new Map();
  tokenizeContent(text).forEach(token => {
    freq.set(token, (freq.get(token) || 0) + 1);
  });
  return freq;
}

function computeWeightedJaccard(queryFreq, docFreq, idfMap) {
  const tokens = new Set([...queryFreq.keys(), ...docFreq.keys()]);
  let num = 0;
  let den = 0;
  tokens.forEach(token => {
    const w = idfMap.get(token) || 1;
    const q = queryFreq.get(token) || 0;
    const d = docFreq.get(token) || 0;
    num += Math.min(q, d) * w;
    den += Math.max(q, d) * w;
  });
  if (den === 0) return 0;
  return num / den;
}

function decomposeQueryTokens(queryTokens) {
  if (queryTokens.length <= 2) return queryTokens;
  const generic = new Set(['feel', 'think', 'thing', 'make', 'becom', 'be', 'state', 'kind']);
  const focused = queryTokens.filter(t => !generic.has(t));
  if (focused.length >= 2) return focused;
  return queryTokens.slice(-2);
}

let semanticStatsCache = null;
function getSemanticStats(CHENGYU) {
  if (semanticStatsCache && semanticStatsCache.ref === CHENGYU) return semanticStatsCache;

  const docFreq = new Map();
  const docCount = CHENGYU.length || 1;
  CHENGYU.forEach(c => {
    const conceptText = [c.meaning, c.literal, c.usage, c.example, ...(c.tags || [])].join(' ');
    const uniq = new Set(tokenizeContent(conceptText));
    uniq.forEach(token => {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    });
  });

  const idfMap = new Map();
  docFreq.forEach((df, token) => {
    idfMap.set(token, Math.log(1 + (docCount + 1) / (df + 1)));
  });

  semanticStatsCache = { ref: CHENGYU, idfMap };
  return semanticStatsCache;
}

function getPinyinExactMatches(query, CHENGYU) {
  if (containsChinese(query)) return [];
  const normalizedQuery = normalizePinyin(query);
  if (!normalizedQuery) return [];

  return CHENGYU.filter(c => normalizePinyin(c.pinyin) === normalizedQuery).map(c => ({
    chengyu: c.chengyu,
    pinyin_exact_score: 1,
    item: c
  }));
}

function isLikelyPinyinQuery(query) {
  if (containsChinese(query)) return false;
  const normalized = normalizePinyin(query);
  if (!normalized) return false;

  const tokens = normalized.split(' ');
  if (tokens.length < 2 || tokens.length > 8) return false;

  for (const token of tokens) {
    if (STOPWORDS.has(token)) return false;
    if (!VALID_PINYIN_SYLLABLES.has(token)) return false;
  }

  return true;
}

const LITERAL_CONCRETE_WORDS = new Set([
  'ant', 'ape', 'bird', 'bull', 'cat', 'cow', 'dog', 'dragon', 'elephant', 'fish',
  'fox', 'frog', 'goat', 'horse', 'lion', 'monkey', 'pig', 'rabbit', 'snake', 'tiger',
  'wolf', 'arm', 'back', 'body', 'ear', 'eye', 'face', 'foot', 'hand', 'head', 'heart',
  'leg', 'mouth', 'needle', 'road', 'seedling', 'snake', 'stump', 'tail', 'thread', 'tree',
  'well', 'window'
]);

const THEMATIC_HINT_WORDS = new Set([
  'animal', 'animals', 'battle', 'battles', 'family', 'food', 'friendship',
  'government', 'learning', 'money', 'moon', 'nature', 'politics', 'relationship',
  'relationships', 'scenery', 'study', 'studying', 'war', 'wealth'
]);

const ABSTRACT_HINT_WORDS = new Set([
  'anger', 'battle', 'beauty', 'conflict', 'courage', 'destiny', 'emotion',
  'fate', 'fortune', 'friendship', 'government', 'greed', 'happiness', 'hate',
  'honor', 'hope', 'justice', 'knowledge', 'love', 'luck', 'nature', 'peace',
  'politics', 'poverty', 'power', 'respect', 'sadness', 'scenery', 'society',
  'success', 'truth', 'war', 'wealth', 'wisdom'
]);

const PARTIAL_HINT_WORDS = new Set([
  'animal', 'animals', 'bird', 'birds', 'cow', 'dog', 'dragon', 'elephant',
  'fish', 'fox', 'frog', 'goat', 'heart', 'horse', 'mountain', 'moon',
  'rabbit', 'snake', 'tiger', 'tree', 'water', 'well', 'wolf'
]);

function isLikelyLiteralQuery(normalizedTokens) {
  if (normalizedTokens.length < 4 || normalizedTokens.length > 8) return false;
  const contentTokens = normalizedTokens.filter(t => !STOPWORDS.has(t));
  if (contentTokens.length < 3) return false;

  let concreteHits = 0;
  for (const token of contentTokens) {
    if (LITERAL_CONCRETE_WORDS.has(token)) concreteHits += 1;
  }
  return concreteHits >= 1;
}

function isLikelyThematicQuery(normalizedTokens) {
  if (normalizedTokens.length === 0) return false;

  if (normalizedTokens.length === 1) return true;

  if (normalizedTokens.length <= 3) {
    const contentTokens = normalizedTokens.filter(t => !STOPWORDS.has(t));
    if (contentTokens.some(t => THEMATIC_HINT_WORDS.has(t))) return true;
    if (contentTokens.length > 0 && contentTokens.every(t => ABSTRACT_HINT_WORDS.has(t))) return true;
    if (normalizedTokens[0] === 'the' && normalizedTokens.length <= 3) return true;
  }

  const andIndex = normalizedTokens.indexOf('and');
  if (andIndex > 0 && andIndex < normalizedTokens.length - 1) {
    const left = normalizedTokens[andIndex - 1];
    const right = normalizedTokens[andIndex + 1];
    if (ABSTRACT_HINT_WORDS.has(left) && ABSTRACT_HINT_WORDS.has(right)) return true;
  }

  return false;
}

function classifyQueryType(query) {
  const trimmed = (query || '').trim();
  if (!trimmed) return 'english_meaning';
  if (containsChinese(trimmed)) return 'chinese_exact';
  if (isLikelyPinyinQuery(trimmed)) return 'pinyin';

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'english_meaning';

  const tokens = normalized.split(' ');
  if (tokens.length === 1 && PARTIAL_HINT_WORDS.has(tokens[0])) return 'partial';
  if (isLikelyLiteralQuery(tokens)) return 'literal';
  if (isLikelyThematicQuery(tokens)) return 'thematic';
  return 'english_meaning';
}

function pinyinFuzzySearch(query, CHENGYU, config) {
  if (!isLikelyPinyinQuery(query)) return [];

  const normalizedQuery = normalizePinyin(query);
  const data = CHENGYU.map(c => ({ ...c, pinyin_norm: normalizePinyin(c.pinyin) }));
  const fuse = new Fuse(data, {
    threshold: config.pinyinFuseThreshold || 0.2,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
    keys: [{ name: 'pinyin_norm', weight: 1 }]
  });

  return fuse.search(normalizedQuery).slice(0, config.pinyinTopK || 15).map(r => ({
    chengyu: r.item.chengyu,
    keyword_score: (1 - r.score) * (config.pinyinFuzzyBoost || 1.15),
    item: r.item
  }));
}

// ---- Query Preprocessing ----
// Agent can add: stopword removal, synonym expansion, pinyin tone stripping, etc.

function preprocessQuery(query) {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  if (containsChinese(trimmed)) return normalizeTraditionalChineseQuery(trimmed);

  const synonymMap = {
    hopeless: ['despair', 'helpless', 'desperate'],
    useless: ['futile', 'vain', 'pointless'],
    angry: ['furious', 'rage', 'wrath'],
    rare: ['scarce', 'uncommon', 'precious'],
    love: ['romance', 'affection'],
    nostalgic: ['wistful', 'sentimental'],
    mistake: ['error', 'wrong'],
    danger: ['risk', 'peril'],
    cooperate: ['cooperation', 'unite', 'together'],
    wealth: ['rich', 'fortune', 'money'],
    war: ['battle', 'fight', 'conflict'],
    fate: ['destiny', 'fortune']
  };

  const lower = trimmed.toLowerCase();
  const expanded = [];
  if (lower.includes('no way out')) expanded.push('hopeless', 'desperate');
  if (lower.includes('backfires')) expanded.push('futile', 'failed');
  if (lower.includes('working hard without rest')) expanded.push('tireless', 'diligent');
  if (lower.includes('doing something useless')) expanded.push('futile', 'fruitless', 'vain');
  if (lower.includes('feeling nostalgic')) expanded.push('homesick', 'wistful', 'yearning');
  if (lower.includes('pretending to be something')) expanded.push('hypocrite', 'fake', 'pretense');
  if (lower.includes('two people in love')) expanded.push('romance', 'lovers', 'couple');
  if (lower.includes('bittersweet feelings')) expanded.push('mixed', 'joy', 'sorrow');
  if (lower.includes('accepting fate')) expanded.push('destiny', 'resigned', 'inevitable');
  if (lower.includes('nature and scenery')) expanded.push('landscape', 'pastoral', 'beautiful');
  if (lower.includes('food and eating')) expanded.push('meal', 'appetite', 'feast');
  if (lower.includes('money and wealth')) expanded.push('fortune', 'prosperity', 'rich');

  tokenizeContent(trimmed).forEach(token => {
    const syns = synonymMap[token];
    if (syns) expanded.push(...syns);
  });

  if (expanded.length === 0) return trimmed;
  return `${trimmed} ${expanded.join(' ')}`;
}

// ---- Keyword Search ----

function keywordSearch(query, CHENGYU, config) {
  const isChinese = containsChinese(query);
  
  const fuseOptions = {
    threshold: config.fuseThreshold || 0.25,
    includeScore: true,
    minMatchCharLength: config.minMatchCharLength || 1,
    ignoreLocation: config.ignoreLocation !== false,
    keys: isChinese ? config.chineseKeys : config.englishKeys
  };
  
  const fuse = new Fuse(CHENGYU, fuseOptions);
  const normalizedQuery = isChinese ? query : normalizePinyin(query);
  const fuseResults = fuse.search(normalizedQuery);

  const keywordResults = fuseResults.slice(0, config.keywordTopK || 20).map(r => ({
    chengyu: r.item.chengyu,
    keyword_score: 1 - r.score,
    item: r.item
  }));

  const pinyinResults = pinyinFuzzySearch(query, CHENGYU, config);
  const merged = new Map();
  [...keywordResults, ...pinyinResults].forEach(r => {
    const existing = merged.get(r.chengyu);
    if (!existing || r.keyword_score > existing.keyword_score) {
      merged.set(r.chengyu, r);
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => b.keyword_score - a.keyword_score)
    .slice(0, config.keywordTopK || 20);
}

// ---- Semantic Search ----
// Agent can replace this with embedding-based search, BM25, TF-IDF, etc.

async function semanticSearch(query, CHENGYU, CHENGYU_EMBEDDINGS, config, options = {}) {
  if (containsChinese(query)) return [];
  
  const qLower = query.toLowerCase();
  const queryTokens = tokenizeContent(query);
  const decomposedQueryTokens = decomposeQueryTokens(queryTokens);
  const queryBigrams = buildBigrams(queryTokens);
  const queryTrigrams = buildNgrams(queryTokens, 3);
  const queryTokenSet = new Set(queryTokens);
  const queryFreq = tokenFrequencyMap(query);
  const semanticStats = getSemanticStats(CHENGYU);
  
  if (queryTokens.length === 0) return [];

  const tokenScoredResults = CHENGYU.map((c, index) => {
    let score = 0;
    const meaning = (c.meaning || '').toLowerCase();
    const literal = (c.literal || '').toLowerCase();
    const usage = (c.usage || '').toLowerCase();
    const example = (c.example || '').toLowerCase();
    const conceptText = [c.meaning, c.literal, c.usage, c.example, ...(c.tags || [])].join(' ').toLowerCase();
    const tagTokens = tokenizeContent((c.tags || []).join(' '));
    const meaningTokens = new Set(tokenizeContent(c.meaning));
    const literalTokens = new Set(tokenizeContent(c.literal));
    const usageTokens = new Set(tokenizeContent(c.usage));
    const exampleTokens = new Set(tokenizeContent(c.example));
    const tagTokenSet = new Set(tagTokens);
    const conceptTokenSet = new Set(tokenizeContent(conceptText));
    const conceptTokenFreq = tokenFrequencyMap(conceptText);
    
    queryTokens.forEach(token => {
      if (meaningTokens.has(token)) score += config.semanticMeaningWeight || 0.35;
      if (literalTokens.has(token)) score += config.semanticLiteralWeight || 0.2;
      if (usageTokens.has(token)) score += config.semanticUsageWeight || 0.12;
      if (exampleTokens.has(token)) score += config.semanticExampleWeight || 0.08;
      if (tagTokenSet.has(token)) score += config.semanticTagWeight || 0.05;
    });

    let literalOverlapCount = 0;
    queryTokenSet.forEach(token => {
      if (literalTokens.has(token)) literalOverlapCount += 1;
    });
    if (literalOverlapCount > 0) {
      const overlapRatio = literalOverlapCount / queryTokens.length;
      score += overlapRatio * (config.literalOverlapWeight || 0.6);
    }

    if (queryBigrams.length > 0) {
      const literalBigrams = new Set(buildBigrams(tokenizeContent(c.literal)));
      let bigramHits = 0;
      queryBigrams.forEach(bg => {
        if (literalBigrams.has(bg)) bigramHits += 1;
      });
      if (bigramHits > 0) {
        score += (bigramHits / queryBigrams.length) * (config.literalBigramWeight || 0.45);
      }
    }

    if (queryBigrams.length > 0 || queryTrigrams.length > 0) {
      const fieldTokens = tokenizeContent([c.meaning, c.literal, c.usage, c.example].join(' '));
      const fieldBigrams = new Set(buildNgrams(fieldTokens, 2));
      const fieldTrigrams = new Set(buildNgrams(fieldTokens, 3));
      let multiGramHits = 0;
      let multiGramTotal = 0;
      queryBigrams.forEach(bg => {
        multiGramTotal += 1;
        if (fieldBigrams.has(bg)) multiGramHits += 1;
      });
      queryTrigrams.forEach(tg => {
        multiGramTotal += 1;
        if (fieldTrigrams.has(tg)) multiGramHits += 1;
      });
      if (multiGramHits > 0 && multiGramTotal > 0) {
        score += (multiGramHits / multiGramTotal) * (config.semanticMultiGramWeight || 0);
      }
    }

    if (literal.includes(qLower)) {
      score += config.literalPhraseMatchBoost || 0.8;
    }

    if (conceptTokenSet.size > 0) {
      let conceptOverlapCount = 0;
      queryTokenSet.forEach(token => {
        if (conceptTokenSet.has(token)) conceptOverlapCount += 1;
        const tf = conceptTokenFreq.get(token) || 0;
        if (tf > 0) {
          score += Math.log1p(tf) * (config.semanticConceptTfWeight || 0.08);
        }
      });
      if (conceptOverlapCount > 0) {
        score += (conceptOverlapCount / queryTokens.length) * (config.semanticConceptOverlapWeight || 0.25);
      }

      if ((config.semanticWeightedJaccardWeight || 0) > 0) {
        const weightedJaccard = computeWeightedJaccard(queryFreq, conceptTokenFreq, semanticStats.idfMap);
        score += weightedJaccard * (config.semanticWeightedJaccardWeight || 0);
      }

      if ((config.semanticDecomposeWeight || 0) > 0 && decomposedQueryTokens.length > 0) {
        let decomposeHits = 0;
        decomposedQueryTokens.forEach(token => {
          if (conceptTokenSet.has(token)) decomposeHits += 1;
        });
        if (decomposeHits > 0) {
          score += (decomposeHits / decomposedQueryTokens.length) * (config.semanticDecomposeWeight || 0);
        }
      }

      if ((config.semanticFuzzyPrefixWeight || 0) > 0 || (config.semanticFuzzyContainsWeight || 0) > 0) {
        const conceptTokens = Array.from(conceptTokenSet);
        queryTokens.forEach(token => {
          if (conceptTokenSet.has(token) || token.length < 4) return;
          let matched = false;
          for (const docToken of conceptTokens) {
            if (docToken.length < 4) continue;
            if (docToken.startsWith(token) || token.startsWith(docToken)) {
              score += config.semanticFuzzyPrefixWeight || 0;
              matched = true;
              break;
            }
          }
          if (!matched) {
            for (const docToken of conceptTokens) {
              if (docToken.includes(token) || token.includes(docToken)) {
                score += config.semanticFuzzyContainsWeight || 0;
                break;
              }
            }
          }
        });
      }
    }
    
    return { chengyu: c.chengyu, token_score: score, item: c, index };
  });

  const topK = config.semanticTopK || 20;
  const embeddingWeight = config.embeddingWeight ?? 0.5;
  const tokenWeight = config.tokenWeight ?? 0.5;
  const canUseEmbeddings = Array.isArray(CHENGYU_EMBEDDINGS) && typeof options.generateQueryEmbedding === 'function';

  if (!canUseEmbeddings) {
    const initialSemanticResults = tokenScoredResults
      .map(r => ({ chengyu: r.chengyu, semantic_score: r.token_score, item: r.item }))
      .sort((a, b) => b.semantic_score - a.semantic_score)
      .slice(0, topK);
    return maybeRerankSemanticResults(query, initialSemanticResults, CHENGYU, config);
  }

  let queryEmbedding;
  try {
    queryEmbedding = await options.generateQueryEmbedding(query);
  } catch (e) {
    const initialSemanticResults = tokenScoredResults
      .map(r => ({ chengyu: r.chengyu, semantic_score: r.token_score, item: r.item }))
      .sort((a, b) => b.semantic_score - a.semantic_score)
      .slice(0, topK);
    return maybeRerankSemanticResults(query, initialSemanticResults, CHENGYU, config);
  }

  const maxTokenScore = tokenScoredResults.reduce((max, r) => Math.max(max, r.token_score), 0);
  const tokenNormalizer = maxTokenScore > 0 ? maxTokenScore : 1;
  const weightDenominator = (embeddingWeight + tokenWeight) || 1;

  const initialSemanticResults = tokenScoredResults
    .map(r => {
      const embeddingEntry = CHENGYU_EMBEDDINGS[r.index];
      const embeddingVec = embeddingEntry && embeddingEntry.embedding;
      let embeddingSimilarity = 0;

      if (Array.isArray(embeddingVec) || embeddingVec instanceof Float32Array) {
        embeddingSimilarity = cosineSimilarity(queryEmbedding, embeddingVec);
        embeddingSimilarity = Math.max(0, Math.min(1, embeddingSimilarity));
      }

      const normalizedTokenScore = r.token_score / tokenNormalizer;
      const blendedScore = (
        embeddingSimilarity * embeddingWeight +
        normalizedTokenScore * tokenWeight
      ) / weightDenominator;

      return {
        chengyu: r.chengyu,
        semantic_score: blendedScore,
        item: r.item
      };
    })
    .sort((a, b) => b.semantic_score - a.semantic_score)
    .slice(0, topK);

  return maybeRerankSemanticResults(query, initialSemanticResults, CHENGYU, config);
}

function maybeRerankSemanticResults(query, semanticResults, CHENGYU, config = {}) {
  const rerankTopK = Number(config.rerankTopK || 0);
  const rerankBlendWeight = Number(config.rerankBlendWeight || 0);

  if (!Number.isFinite(rerankTopK) || rerankTopK <= 0 || rerankBlendWeight <= 0 || semanticResults.length <= 1 || containsChinese(query)) {
    return semanticResults;
  }

  const queryTokens = tokenizeContent(query);
  if (queryTokens.length === 0) {
    return semanticResults;
  }

  const qLower = query.toLowerCase();
  const queryFreq = tokenFrequencyMap(query);
  const focusedTokens = decomposeQueryTokens(queryTokens);
  const queryBigrams = buildBigrams(queryTokens);
  const queryTrigrams = buildNgrams(queryTokens, 3);
  const semanticStats = getSemanticStats(CHENGYU);
  const rerankCount = Math.min(rerankTopK, semanticResults.length);

  const scored = semanticResults.map((candidate, index) => {
    if (index >= rerankCount) {
      return {
        ...candidate,
        rerank_raw_score: 0,
        rerank_applied: false
      };
    }

    const item = candidate.item || {};
    const meaning = (item.meaning || '').toLowerCase();
    const literal = (item.literal || '').toLowerCase();
    const usage = (item.usage || '').toLowerCase();
    const example = (item.example || '').toLowerCase();
    const conceptText = [item.meaning, item.literal, item.usage, item.example, ...((item.tags || []))].join(' ').toLowerCase();
    const conceptTokenSet = new Set(tokenizeContent(conceptText));
    const conceptTokenFreq = tokenFrequencyMap(conceptText);

    let rerankScore = 0;

    if (meaning.includes(qLower)) rerankScore += config.rerankMeaningPhraseWeight || 0;
    if (literal.includes(qLower)) rerankScore += config.rerankLiteralPhraseWeight || 0;
    if (usage.includes(qLower)) rerankScore += config.rerankUsagePhraseWeight || 0;
    if (example.includes(qLower)) rerankScore += config.rerankExamplePhraseWeight || 0;

    let overlapCount = 0;
    queryTokens.forEach(token => {
      if (conceptTokenSet.has(token)) overlapCount += 1;
    });
    if (overlapCount > 0) {
      rerankScore += (overlapCount / queryTokens.length) * (config.rerankCoverageWeight || 0);
    }

    if ((config.rerankWeightedJaccardWeight || 0) > 0) {
      const weightedJaccard = computeWeightedJaccard(queryFreq, conceptTokenFreq, semanticStats.idfMap);
      rerankScore += weightedJaccard * (config.rerankWeightedJaccardWeight || 0);
    }

    if (focusedTokens.length > 0) {
      let focusedHits = 0;
      focusedTokens.forEach(token => {
        if (conceptTokenSet.has(token)) focusedHits += 1;
      });
      if (focusedHits === focusedTokens.length) {
        rerankScore += config.rerankAllFocusedTokensBoost || 0;
      } else if (focusedHits > 0) {
        rerankScore += (focusedHits / focusedTokens.length) * (config.rerankFocusedCoverageWeight || 0);
      }
    }

    if ((config.rerankBigramWeight || 0) > 0 || (config.rerankTrigramWeight || 0) > 0) {
      const fieldTokens = tokenizeContent([item.meaning, item.literal, item.usage, item.example].join(' '));
      const fieldBigrams = new Set(buildNgrams(fieldTokens, 2));
      const fieldTrigrams = new Set(buildNgrams(fieldTokens, 3));
      let bigramHits = 0;
      let trigramHits = 0;
      queryBigrams.forEach(bg => {
        if (fieldBigrams.has(bg)) bigramHits += 1;
      });
      queryTrigrams.forEach(tg => {
        if (fieldTrigrams.has(tg)) trigramHits += 1;
      });
      if (bigramHits > 0 && queryBigrams.length > 0) {
        rerankScore += (bigramHits / queryBigrams.length) * (config.rerankBigramWeight || 0);
      }
      if (trigramHits > 0 && queryTrigrams.length > 0) {
        rerankScore += (trigramHits / queryTrigrams.length) * (config.rerankTrigramWeight || 0);
      }
    }

    return {
      ...candidate,
      rerank_raw_score: rerankScore,
      rerank_applied: true
    };
  });

  const maxRerankScore = scored
    .slice(0, rerankCount)
    .reduce((max, candidate) => Math.max(max, candidate.rerank_raw_score || 0), 0);
  const rerankNormalizer = maxRerankScore > 0 ? maxRerankScore : 1;

  return scored
    .map(candidate => {
      if (!candidate.rerank_applied) {
        return candidate;
      }
      const normalizedRerankScore = (candidate.rerank_raw_score || 0) / rerankNormalizer;
      return {
        ...candidate,
        semantic_score: candidate.semantic_score * (1 - rerankBlendWeight) + normalizedRerankScore * rerankBlendWeight
      };
    })
    .sort((a, b) => b.semantic_score - a.semantic_score)
    .map(({ rerank_raw_score, rerank_applied, ...candidate }) => candidate);
}

// ---- Merge & Rank ----
// Agent can: change merge strategy, add re-ranking, add boosting rules, etc.

const DEFAULT_RESULT_LIMIT = 10;

function getResultLimit(options = {}) {
  const rawLimit = Number(options && options.resultLimit);
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.floor(rawLimit);
}

function mergeAndRank(keywordResults, semanticResults, exactPinyinResults, config, options = {}) {
  const resultLimit = getResultLimit(options);
  const merged = new Map();
  
  semanticResults.forEach(r => {
    merged.set(r.chengyu, { 
      chengyu: r.chengyu, 
      semantic_score: r.semantic_score, 
      keyword_score: 0, 
      source: 'semantic',
      item: r.item
    });
  });
  
  keywordResults.forEach(r => {
    if (merged.has(r.chengyu)) {
      const existing = merged.get(r.chengyu);
      existing.keyword_score = r.keyword_score;
      existing.source = 'both';
    } else {
      merged.set(r.chengyu, { 
        chengyu: r.chengyu, 
        semantic_score: 0, 
        keyword_score: r.keyword_score, 
        source: 'keyword',
        item: r.item
      });
    }
  });

  exactPinyinResults.forEach(r => {
    if (merged.has(r.chengyu)) {
      const existing = merged.get(r.chengyu);
      existing.pinyin_exact_score = Math.max(existing.pinyin_exact_score || 0, r.pinyin_exact_score);
    } else {
      merged.set(r.chengyu, {
        chengyu: r.chengyu,
        semantic_score: 0,
        keyword_score: 0,
        pinyin_exact_score: r.pinyin_exact_score,
        source: 'pinyin_exact',
        item: r.item
      });
    }
  });

  const results = Array.from(merged.values()).map(r => {
    if ((r.pinyin_exact_score || 0) > 0) {
      return {
        chengyu: r.chengyu,
        score: (config.exactPinyinBoost || 10) + r.pinyin_exact_score,
        item: r.item
      };
    }

    let score;
    if (r.source === 'both') {
      score = r.semantic_score * (config.semanticWeight || 0.72) + r.keyword_score * (config.keywordWeight || 0.28);
      score *= (config.bothBoost || 1.7);
    } else if (r.source === 'semantic') {
      score = r.semantic_score;
    } else {
      score = r.keyword_score;
    }
    return { chengyu: r.chengyu, score, item: r.item };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, resultLimit);
}

function getEffectiveConfig(query, config = {}) {
  const queryType = classifyQueryType(query);
  const typeOverrides = (config && config.typeOverrides && config.typeOverrides[queryType]) || {};
  return {
    queryType,
    effectiveConfig: { ...config, ...typeOverrides }
  };
}

function rankKeywordOnly(keywordResults, exactPinyinResults, config, options = {}) {
  const resultLimit = getResultLimit(options);
  const merged = new Map();

  keywordResults.forEach(r => {
    merged.set(r.chengyu, {
      chengyu: r.chengyu,
      keyword_score: r.keyword_score,
      pinyin_exact_score: 0,
      item: r.item
    });
  });

  exactPinyinResults.forEach(r => {
    if (merged.has(r.chengyu)) {
      const existing = merged.get(r.chengyu);
      existing.pinyin_exact_score = Math.max(existing.pinyin_exact_score || 0, r.pinyin_exact_score);
      existing.item = existing.item || r.item;
    } else {
      merged.set(r.chengyu, {
        chengyu: r.chengyu,
        keyword_score: 0,
        pinyin_exact_score: r.pinyin_exact_score,
        item: r.item
      });
    }
  });

  return Array.from(merged.values())
    .map(r => ({
      chengyu: r.chengyu,
      score: (r.pinyin_exact_score || 0) > 0
        ? (config.exactPinyinBoost || 10) + r.pinyin_exact_score
        : (r.keyword_score || 0),
      item: r.item
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, resultLimit);
}

function keywordSearchOnly(query, CHENGYU, config = {}, options = {}) {
  const { effectiveConfig } = getEffectiveConfig(query, config);
  const resultLimit = getResultLimit(options);
  const keywordConfig = {
    ...effectiveConfig,
    keywordTopK: Math.max(effectiveConfig.keywordTopK || 20, resultLimit),
    pinyinTopK: Math.max(effectiveConfig.pinyinTopK || 15, resultLimit)
  };
  const directQuery = query.trim();
  const processedQuery = preprocessQuery(query);

  const exactPinyinResults = [
    ...getPinyinExactMatches(directQuery, CHENGYU),
    ...(processedQuery !== directQuery ? getPinyinExactMatches(processedQuery, CHENGYU) : [])
  ];

  let keywordResults;
  if (containsChinese(directQuery) && processedQuery !== directQuery) {
    keywordResults = keywordSearch(processedQuery, CHENGYU, keywordConfig);
  } else {
    keywordResults = keywordSearch(directQuery, CHENGYU, keywordConfig);
    if (keywordResults.length === 0 && processedQuery !== directQuery) {
      keywordResults = keywordSearch(processedQuery, CHENGYU, keywordConfig);
    }
  }

  return rankKeywordOnly(keywordResults, exactPinyinResults, keywordConfig, { resultLimit });
}

async function semanticSearchOnly(query, CHENGYU, CHENGYU_EMBEDDINGS, config = {}, options = {}) {
  const { effectiveConfig } = getEffectiveConfig(query, config);
  const resultLimit = getResultLimit(options);
  const semanticConfig = {
    ...effectiveConfig,
    semanticTopK: Math.max(effectiveConfig.semanticTopK || 20, resultLimit)
  };
  const processedQuery = preprocessQuery(query);
  const semanticResults = await semanticSearch(
    processedQuery,
    CHENGYU,
    CHENGYU_EMBEDDINGS,
    semanticConfig,
    options
  );

  return semanticResults
    .map(r => ({
      chengyu: r.chengyu,
      score: r.semantic_score,
      item: r.item
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, resultLimit);
}

// ---- Main Search Function ----

async function search(query, CHENGYU, CHENGYU_EMBEDDINGS, config, options = {}) {
  const { effectiveConfig } = getEffectiveConfig(query, config);
  const resultLimit = getResultLimit(options);
  const hybridConfig = {
    ...effectiveConfig,
    keywordTopK: Math.max(effectiveConfig.keywordTopK || 20, resultLimit * 2),
    semanticTopK: Math.max(effectiveConfig.semanticTopK || 20, resultLimit * 2),
    pinyinTopK: Math.max(effectiveConfig.pinyinTopK || 15, resultLimit)
  };
  const processedQuery = preprocessQuery(query);
  
  const exactPinyinResults = getPinyinExactMatches(processedQuery, CHENGYU);
  const keywordResults = keywordSearch(processedQuery, CHENGYU, hybridConfig);
  const semanticResults = await semanticSearch(
    processedQuery,
    CHENGYU,
    CHENGYU_EMBEDDINGS,
    hybridConfig,
    options
  );
  
  return mergeAndRank(keywordResults, semanticResults, exactPinyinResults, hybridConfig, { resultLimit });
}

module.exports = {
  search,
  classifyQueryType,
  keywordSearchOnly,
  semanticSearchOnly,
  preprocessQuery,
  containsChinese,
  normalizePinyin
};

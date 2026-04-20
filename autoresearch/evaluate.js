#!/usr/bin/env node
/**
 * Evaluate search quality using NDCG (Normalized Discounted Cumulative Gain).
 * Runs all test queries against the search engine and computes a single score.
 * 
 * Usage: node evaluate.js [--verbose]
 * Exit code 0 = success, outputs JSON with score to stdout.
 */

const fs = require('fs');
const path = require('path');

// ---- Load the search configuration and logic ----
const searchConfig = require('./search-config.js');
const { search: searchFn } = require('./search-logic.js');

// ---- Load data ----
const CHENGYU = require('../chengyuData.js');
const testSet = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-set.json'), 'utf8'));

// ---- Embeddings ----
let CHENGYU_EMBEDDINGS = null;
try {
  const embData = fs.readFileSync(path.join(__dirname, '..', 'embeddings-local.json'), 'utf8');
  const parsedEmbeddings = JSON.parse(embData);
  CHENGYU_EMBEDDINGS = Array.isArray(parsedEmbeddings)
    ? parsedEmbeddings
    : parsedEmbeddings.embeddings;
} catch (e) {
  console.error('Warning: No embeddings found, semantic search disabled');
}

// ---- Search wrapper (delegates to search-logic.js) ----
async function search(query) {
  return searchFn(query, CHENGYU, CHENGYU_EMBEDDINGS, searchConfig);
}

// ---- NDCG calculation ----
function dcg(relevances, k) {
  let score = 0;
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    score += relevances[i] / Math.log2(i + 2); // i+2 because log2(1) = 0
  }
  return score;
}

function ndcg(actualResults, expectedResults, k = 5) {
  // Build relevance map from expected
  const relMap = new Map();
  expectedResults.forEach(e => relMap.set(e.chengyu, e.relevance));
  
  // Get relevances for actual results
  const actualRels = actualResults.slice(0, k).map(r => relMap.get(r.chengyu) || 0);
  
  // Ideal: sort expected by relevance descending
  const idealRels = expectedResults.map(e => e.relevance).sort((a, b) => b - a).slice(0, k);
  
  const actualDCG = dcg(actualRels, k);
  const idealDCG = dcg(idealRels, k);
  
  if (idealDCG === 0) return 0;
  return actualDCG / idealDCG;
}

// ---- Main evaluation ----
async function evaluate() {
  const verbose = process.argv.includes('--verbose');
  const PRIMARY_TYPES = new Set(['english_meaning', 'thematic']);
  let primaryTotalNDCG = 0;
  let primaryQueryCount = 0;
  let totalQueryCount = 0;
  const perQuery = [];

  for (const testCase of testSet) {
    if (testCase.expected.length === 0) continue;
    
    const results = await search(testCase.query);
    const score = ndcg(results, testCase.expected, 5);
    totalQueryCount++;
    if (PRIMARY_TYPES.has(testCase.type)) {
      primaryTotalNDCG += score;
      primaryQueryCount++;
    }
    
    if (verbose) {
      const topChengyu = results.slice(0, 3).map(r => r.chengyu).join(', ');
      console.error(`  ${testCase.query}: NDCG@5=${score.toFixed(4)} → [${topChengyu}]`);
    }
    
    perQuery.push({ query: testCase.query, type: testCase.type, ndcg: score });
  }

  const avgNDCG = primaryQueryCount > 0 ? primaryTotalNDCG / primaryQueryCount : 0;
  
  // Per-type breakdown
  const byType = {};
  perQuery.forEach(pq => {
    if (!byType[pq.type]) byType[pq.type] = [];
    byType[pq.type].push(pq.ndcg);
  });
  
  const typeScores = {};
  for (const [type, scores] of Object.entries(byType)) {
    typeScores[type] = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4);
  }

  const result = {
    avg_ndcg: parseFloat(avgNDCG.toFixed(6)),
    query_count: primaryQueryCount,
    total_query_count: totalQueryCount,
    primary_types: Array.from(PRIMARY_TYPES),
    by_type: typeScores,
    timestamp: new Date().toISOString()
  };

  // Output to stdout as JSON (for the autoresearch loop to parse)
  console.log(JSON.stringify(result));
  
  if (verbose) {
    console.error(`\n=== Average NDCG@5 (primary: english_meaning+thematic): ${avgNDCG.toFixed(6)} (${primaryQueryCount} queries) ===`);
    console.error('By type:', typeScores);
  }
}

evaluate().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
const DEFAULT_BASE_URL = 'https://findchengyu.com';

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function resolveBaseUrl(args) {
  const rawUrl = args.url || process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL;
  return rawUrl.replace(/\/+$/, '');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent': 'chengyu-search-smoke/1.0',
      accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return body;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function smokeSearch(baseUrl, { query, expectedFirst, expectedMode }) {
  const body = await fetchJson(`${baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });

  const results = Array.isArray(body.results) ? body.results : [];
  assert(results.length > 0, `Expected results for query "${query}"`);

  const responseMode = body.searchMode || body.mode;

  if (expectedMode) {
    assert(
      responseMode === expectedMode,
      `Expected query "${query}" to use ${expectedMode}, got ${responseMode || 'unknown'}`
    );
  }

  if (expectedFirst) {
    const first = results[0];
    const firstLabel = first.simplified || first.chengyu || first.word || '';
    assert(
      firstLabel === expectedFirst,
      `Expected first result for "${query}" to be ${expectedFirst}, got ${firstLabel || 'unknown'}`
    );
  }

  return {
    query,
    mode: responseMode,
    count: results.length,
    first: results[0].simplified || results[0].chengyu || results[0].word || null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = resolveBaseUrl(args);

  const health = await fetchJson(`${baseUrl}/api/health`);
  assert(health.status === 'ok', `Expected healthy status, got ${health.status || 'unknown'}`);
  assert(health.database === true, 'Expected database to be loaded');
  assert(health.embeddings === true, 'Expected embedding artifact to be loaded');

  const checks = [];
  checks.push(await smokeSearch(baseUrl, {
    query: 'feeling hopeless',
    expectedMode: 'semantic'
  }));
  checks.push(await smokeSearch(baseUrl, {
    query: '画蛇添足',
    expectedFirst: '画蛇添足',
    expectedMode: 'hybrid'
  }));
  checks.push(await smokeSearch(baseUrl, {
    query: 'hua she tian zu',
    expectedFirst: '画蛇添足',
    expectedMode: 'hybrid'
  }));

  console.log(JSON.stringify({ ok: true, baseUrl, health, checks }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveBaseUrl,
  smokeSearch
};

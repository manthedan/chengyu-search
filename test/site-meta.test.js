const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('site metadata and SEO assets', () => {
  it('includes canonical, description, and social-card metadata in public/index.html', () => {
    const html = readRepoFile('public/index.html');

    assert.match(html, /<link rel="canonical" href="https:\/\/findchengyu\.com\/">/);
    assert.match(html, /<meta name="description" content="Search Chinese idioms by meaning, Chinese characters, or pinyin\./);
    assert.match(html, /<meta property="og:title" content="Chengyu Search — Search Chinese Idioms by Meaning, Characters, or Pinyin">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/findchengyu\.com\/social-card\.png">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<script type="application\/ld\+json">/);
  });

  it('ships robots.txt and sitemap.xml for the canonical domain', () => {
    const robots = readRepoFile('public/robots.txt');
    const sitemap = readRepoFile('public/sitemap.xml');

    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Disallow: \/api\/$/m);
    assert.match(robots, /^Sitemap: https:\/\/findchengyu\.com\/sitemap\.xml$/m);

    assert.match(sitemap, /<loc>https:\/\/findchengyu\.com\/<\/loc>/);
  });

  it('includes the social preview and icon assets', () => {
    const socialCardPath = path.join(REPO_ROOT, 'public', 'social-card.png');
    const appleTouchIconPath = path.join(REPO_ROOT, 'public', 'apple-touch-icon.png');
    const faviconPath = path.join(REPO_ROOT, 'public', 'favicon.svg');

    assert.ok(fs.existsSync(socialCardPath), 'social-card.png should exist');
    assert.ok(fs.statSync(socialCardPath).size > 0, 'social-card.png should not be empty');
    assert.ok(fs.existsSync(appleTouchIconPath), 'apple-touch-icon.png should exist');
    assert.ok(fs.statSync(appleTouchIconPath).size > 0, 'apple-touch-icon.png should not be empty');
    assert.ok(fs.existsSync(faviconPath), 'favicon.svg should exist');
  });
});

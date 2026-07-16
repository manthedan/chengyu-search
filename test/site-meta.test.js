const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(channel => parseInt(channel, 16) / 255);
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
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

  it('ships security.txt with private vulnerability reporting guidance', () => {
    const securityTxt = readRepoFile('public/.well-known/security.txt');

    assert.match(securityTxt, /^Contact: https:\/\/github\.com\/manthedan\/chengyu-search\/security\/advisories\/new$/m);
    assert.match(securityTxt, /^Canonical: https:\/\/findchengyu\.com\/\.well-known\/security\.txt$/m);
    assert.match(securityTxt, /^Expires: /m);
  });

  it('keeps dark-mode primary button states at AA text contrast', () => {
    const styles = readRepoFile('public/styles.css');
    const darkTheme = styles.match(/body\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] || '';
    const foreground = darkTheme.match(/--button-primary-fg:\s*(#[A-Fa-f0-9]{6})/)?.[1];
    const background = darkTheme.match(/--button-primary-bg:\s*(#[A-Fa-f0-9]{6})/)?.[1];
    const hover = darkTheme.match(/--button-primary-hover:\s*(#[A-Fa-f0-9]{6})/)?.[1];

    assert.ok(foreground && background && hover, 'dark-mode primary button tokens should be defined');
    assert.ok(contrastRatio(foreground, background) >= 4.5, 'default dark-mode primary button should meet WCAG AA');
    assert.ok(contrastRatio(foreground, hover) >= 4.5, 'hovered dark-mode primary button should meet WCAG AA');
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

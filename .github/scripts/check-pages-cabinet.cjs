const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { checkCharacterFrames } = require('./check-character-frames.cjs');

const base = new URL(process.argv[2] ?? 'https://timurgromov.github.io/tri-k-osade/phaser/');
const release = readFileSync('phaser/index.html', 'utf8');
const revision = release.match(/<meta name="siege-source-revision" content="([a-f\d]{16})">/)?.[1];
const entry = release.match(/<script type="module"[^>]* src="(\.\/assets\/index-[\w-]+\.js)"/)?.[1];
assert(revision && entry, 'Missing build identity in phaser/index.html');
const expectedEntry = new URL(entry, base).href;

async function openRelease(page, route) {
  const url = new URL(route, base).href;
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    assert.equal(page.url(), url, 'Unexpected navigation');
    const build = await page.evaluate(() => ({
      revision: document.querySelector('meta[name="siege-source-revision"]')?.content,
      entry: document.querySelector('script[type="module"][src]')?.src,
    }));
    if (response?.ok() && build.revision === revision && build.entry === expectedEntry) {
      console.log(`${url} · ${build.revision}`);
      return;
    }
    if (attempt === 6) {
      throw new Error(`${url} returned ${JSON.stringify(build)}, expected ${revision} and ${expectedEntry}`);
    }
    await delay(5000);
  }
}

async function checkLinks(page) {
  const loopback = await page.locator('a[href], area[href], form[action]').evaluateAll(links =>
    links.map(link => link.getAttribute('href') ?? link.getAttribute('action')).filter(target => {
      const url = new URL(target, document.baseURI);
      return url.origin !== location.origin &&
        /(?:^|\.)localhost\.?$|^127\.|^\[(?:::1|::ffff:7f[\da-f]{2}:)/i.test(url.hostname);
    }));
  assert.deepEqual(loopback, [], `Loopback navigation in ${page.url()}`);
}

async function compareSorceressFrames(page, frames) {
  const mismatched = await page.evaluate(async frames => {
    async function pixels(url, x, y, width, height) {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, -x, -y);
      return ctx.getImageData(0, 0, width, height).data;
    }
    const bodies = new Map([...document.querySelectorAll('#clip-frames [data-published-body]')]
      .map(frame => [Number(frame.dataset.bodyIndex), frame.dataset.publishedBody]));
    if (bodies.size !== frames.length) throw new Error('Missing published Sorceress body layer');
    return (await Promise.all(frames.map(async (url, index) => {
      const [game, catalog] = await Promise.all([
        pixels(url, 0, 0, 116, 162),
        pixels(bodies.get(index), 68, 10, 116, 162),
      ]);
      return game.every((value, i) => value === catalog[i]) ? [] : [index];
    }))).flat();
  }, frames);
  assert.deepEqual(mismatched, [], 'Game drawings differ from the Sorceress catalog body layers');
}

async function verify() {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    const atlases = new Map();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === base.origin && /\/sorceress-(?!magic-)[\w-]+\.webp$/.test(url.pathname)) {
        atlases.set(url.pathname, response);
      }
    });

    await openRelease(page, '');
    await page.locator('#start').waitFor({ timeout: 15_000 });
    for (const [route, ready] of [
      ['?editor', 'textarea[spellcheck="false"]'],
      ['?editor&review=animation&mission=mage-tower', '#animation-review-heading'],
      ['?editor&catalog&tab=environment&gate=mage-tower', '.catalog-gate-controls'],
    ]) {
      await openRelease(page, route);
      await page.locator(ready).waitFor({ timeout: 15_000 });
      await checkLinks(page);
    }

    await checkCharacterFrames(page, openRelease, async frames => {
      const [atlasUrl] = atlases.keys();
      assert.equal(atlases.size, 1, 'Expected a single Sorceress atlas');
      const atlas = atlases.get(atlasUrl);
      assert(atlas.ok(), `Failed to load ${atlasUrl}`);
      assert((await atlas.body()).equals(readFileSync(join('phaser/assets', basename(atlasUrl)))),
        'The Sorceress atlas served by Pages differs from the checked-out release');
      await compareSorceressFrames(page, frames);
    });
    await checkLinks(page);
    assert.deepEqual(errors, [], 'Browser errors');
  } finally {
    await browser.close();
  }
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

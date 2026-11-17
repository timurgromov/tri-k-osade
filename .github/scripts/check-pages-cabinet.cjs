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

async function compareSorceressFrames(page, atlas, frames) {
  const mismatched = await page.evaluate(async ({ atlas, frames }) => {
    async function load(url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function pixels(image, x, y, width, height) {
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(image, x, y, width, height, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      let left = width;
      let right = -1;
      let top = height;
      let bottom = -1;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          if (data[(row * width + col) * 4 + 3] === 0) continue;
          left = Math.min(left, col);
          right = Math.max(right, col);
          top = Math.min(top, row);
          bottom = Math.max(bottom, row);
        }
      }
      if (right === -1) throw new Error('Empty Sorceress frame');
      return ctx.getImageData(left, top, right - left + 1, bottom - top + 1);
    }
    const sheet = await load(atlas);
    const width = sheet.naturalWidth / 6;
    const height = sheet.naturalHeight / 2;
    const images = await Promise.all(frames.map(load));
    const thumbnails = [...document.querySelectorAll('#animation-montage .montage-frames img')].slice(0, 2);
    if (thumbnails.length !== 2) throw new Error('Missing Sorceress stance or ready thumbnail');
    await Promise.all(thumbnails.map(image => image.decode()));
    function same(a, b) {
      return a.width === b.width && a.height === b.height &&
        a.data.every((value, i) => value === b.data[i]);
    }
    thumbnails.forEach((image, index) => {
      if (!same(pixels(sheet, index * width, 0, width, height), pixels(image, 0, 0, width, height))) {
        throw new Error('Sorceress thumbnail ' + (index + 1) + ' differs from the loaded atlas');
      }
    });
    return images.flatMap((image, index) => {
      const catalog = pixels(sheet, index % 6 * width, Math.floor(index / 6) * height, width, height);
      const battle = pixels(image, 0, 0, image.naturalWidth, image.naturalHeight);
      return same(catalog, battle) ? [] : [index];
    });
  }, { atlas, frames });
  assert.deepEqual(mismatched, [], 'Game drawings differ from the Sorceress catalog');
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
      await compareSorceressFrames(page, atlas.url(), frames);
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

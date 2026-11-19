const assert = require('node:assert/strict');

const cell = 192;
const separateAttackCards = new Set(['yellow', 'orc']);
const fullHeightUnitCards = new Set(['elf', 'orc']);
const frameList = '#animation-montage:not([hidden]) .montage-frames [data-frame] img';

async function sceneReady(page, expectedPosts) {
  try {
    const ready = await page.waitForFunction(expectedPosts => {
      const scene = document.querySelector('#scene');
      if (!scene || (!expectedPosts && !scene.dataset.unitDrawings) || document.querySelector('#play-area')?.inert) return false;
      const fortress = document.querySelector('#fortress');
      if (!fortress || [...fortress.querySelectorAll('[data-placed-garrison]')]
        .some(post => !post.querySelector('[data-defeat-figure]'))) return false;

      const posts = [...fortress.querySelectorAll('[data-defeat-figure]')].map((figure, index) => {
        const root = figure.parentElement;
        // A published assignment hides its authored post at every stage.
        if (root.classList.contains('garrison-replaced')) return null;
        const shown = root.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        const poses = [...root.querySelectorAll('[data-idle-pose]')];
        return {
          index,
          id: figure.dataset.defeatFigure,
          hit: Number(figure.dataset.texturePhase),
          shown,
          ready: Boolean(figure.style.backgroundImage && root.querySelector('[data-defeat-smoke]')?.style.backgroundImage &&
            poses.length && poses.every(pose => pose.naturalWidth > 0 && pose.getAnimations().length > 0)),
        };
      }).filter(Boolean);
      const selected = expectedPosts
        ? expectedPosts.map(expected => {
          const actual = posts.find(post => post.index === expected.index);
          return actual?.id === expected.id && actual.hit === expected.hit ? actual : undefined;
        })
        : posts.filter(post => post.shown);
      return selected.every(post => post?.shown && post.ready) ? posts : false;
    }, expectedPosts ?? null, { timeout: 25_000 });
    try { return await ready.jsonValue(); }
    finally { await ready.dispose(); }
  } catch (error) {
    const stage = await page.locator('#fortress').getAttribute('data-stage', { timeout: 1000 }).catch(() => null);
    const expected = expectedPosts?.map(post => `${post.id} (hit ${post.hit})`).join(', ') ?? 'opening garrison';
    throw new Error(`Garrison drawings unavailable on ${page.url()} at stage ${stage}: ${expected}`, { cause: error });
  }
}

// Take the textures already attached to the actual battle DOM, including aligned atlases.
function readGarrison(entries) {
  const c = 192;
  const matrix = (element, anchor, scale = 1) => {
    const [cols, rows] = element.style.backgroundSize.split(' ').map(value => parseFloat(value) / 100);
    const source = element.style.backgroundImage.match(/^url\("(.*)"\)$/)?.[1];
    if (!cols || !rows || !source) throw new Error('Cannot read the displayed garrison atlas');
    return Array.from({ length: cols * rows }, (_, index) => ({
      source, filter: element.style.filter,
      crop: [index % cols * c, Math.floor(index / cols) * c, c, c],
      dest: [anchor[0] * (1 - scale), anchor[1] * (1 - scale), c * scale, c * scale],
    }));
  };
  const figures = [...document.querySelectorAll('#fortress [data-defeat-figure]')];
  return entries.map(({ index, id, hit }) => {
    const figure = figures[index];
    if (figure?.dataset.defeatFigure !== id || Number(figure.dataset.texturePhase) !== hit ||
      figure.parentElement.classList.contains('garrison-replaced')) {
      throw new Error('Battle post changed before reading its frames: ' + id);
    }
    const root = figure.parentElement;
    const poses = [...root.querySelectorAll('[data-idle-pose]')];
    const keyframes = poses.map(pose => pose.getAnimations().find(clip =>
      clip.effect instanceof KeyframeEffect && clip.effect.getKeyframes().length > 1)?.effect?.getKeyframes());
    const { width, anchor } = JSON.parse(figure.dataset.defeatGeometry);
    const factor = c / width;
    const makePose = pose => {
      const rect = JSON.parse(pose.dataset.idleRect);
      for (const [index, key] of ['left', 'top', 'width', 'height'].entries()) {
        if (Math.abs(parseFloat(pose.style[key]) * 3.9 - rect[index]) > .002) {
          throw new Error('Battle pose bounds differ from its source geometry: ' + figure.dataset.defeatFigure);
        }
      }
      const [x, y, w, h] = rect.map(value => value * factor);
      return { source: pose.currentSrc, filter: pose.style.filter, dest: [anchor[0] + x, anchor[1] + y, w, h] };
    };
    const sequence = keyframes[0].slice(0, -1).map((_, index) => {
      const pose = keyframes.findIndex(keys => Number(keys?.[index]?.opacity) === 1);
      if (pose < 0) throw new Error('No drawn pose in battle: ' + figure.dataset.defeatFigure);
      return makePose(poses[pose]);
    });
    const smoke = root.querySelector('[data-defeat-smoke]');
    const smokeScale = Math.round(parseFloat(smoke.style.width) / parseFloat(figure.style.width) * 100) / 100;
    return { id: figure.dataset.defeatFigure, frames: [
      ...sequence, ...matrix(figure, anchor), ...matrix(smoke, anchor, smokeScale),
    ] };
  });
}

// Normalize the scene's drawing scale on the same transparent canvas used by the card.
async function renderFrames({ groups, cell, type }) {
  const textures = new Map();
  async function load(source) {
    if (!textures.has(source)) {
      const image = new Image();
      image.src = source;
      textures.set(source, image.decode().then(() => image));
    }
    return textures.get(source);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell;
  const ctx = canvas.getContext('2d');
  return Promise.all(groups.map(async layers => Promise.all(layers.map(async layer =>
    ({ ...layer, image: await load(layer.source) }))))).then(frames => frames.map(layers => {
    ctx.clearRect(0, 0, cell, cell);
    for (const { image, crop, dest, filter } of layers) {
      ctx.filter = filter || 'none';
      if (dest) {
        if (crop) ctx.drawImage(image, ...crop, ...dest);
        else ctx.drawImage(image, ...dest);
        continue;
      }

      let height = type === 'hero' ? 144 : 110;
      let top = 168 - height;
      if (type === 'full-height-unit') {
        height = cell;
        top = 0;
      } else if (type === 'attack-card') {
        height = cell * image.naturalHeight / Math.max(image.naturalWidth, image.naturalHeight);
        top = (cell - height) / 2;
      }
      const width = height * image.naturalWidth / image.naturalHeight;
      ctx.drawImage(image, (cell - width) / 2, top, width, height);
    }
    return canvas.toDataURL();
  }));
}

async function compareThumbnails(page, expected) {
  return page.locator(frameList).evaluateAll(async (entries, expected) => {
    if (entries.length !== expected.length) return { actual: entries.length, expected: expected.length };
    const canvas = document.createElement('canvas');
    const c = 192;
    canvas.width = canvas.height = c;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function pixels(image) {
      ctx.clearRect(0, 0, c, c);
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, c, c).data;
    }
    const disagreements = [];
    for (const [index, image] of entries.entries()) {
      if (image.src === expected[index]) continue;
      const other = new Image();
      other.src = expected[index];
      await Promise.all([image.decode(), other.decode()]);
      const a = pixels(image);
      const b = pixels(other);
      let visible = 0;
      let changed = 0;
      let total = 0;
      for (let offset = 0; offset < a.length; offset += 4) {
        if (!a[offset + 3] && !b[offset + 3]) continue;
        visible++;
        let delta = Math.abs(a[offset + 3] - b[offset + 3]);
        for (let channel = 0; channel < 3; channel++) {
          delta += Math.abs(a[offset + channel] * a[offset + 3] - b[offset + channel] * b[offset + 3]) / 255;
        }
        total += delta;
        if (delta > 8) changed++;
      }
      // Allow rounding at translucent edges when drawing CSS filter colors on a canvas.
      if (!visible || total / visible > 1 || changed / visible > 0.005) {
        disagreements.push({ frame: index + 1, average: +(total / visible).toFixed(2),
          changed: +(changed / visible * 100).toFixed(2) });
      }
    }
    return disagreements;
  }, expected);
}

async function checkCharacterFrames(page, openRelease, checkSorceress) {
  await openRelease(page, '?editor&catalog&tab=environment');
  const gates = page.locator('.catalog-gate-stage[data-mission]');
  await gates.first().waitFor();
  const missions = await gates.evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.mission))]);
  const game = new Map();
  const units = new Map();
  let heroScenes = 0;
  function record(registry, id, mission, frames) {
    const kits = registry.get(id) ?? [];
    const same = kits.find(kit => kit.frames.every((image, index) => frames[index] === image)
      && kit.frames.length === frames.length);
    if (same) same.missions.push(mission);
    else kits.push({ frames, missions: [mission] });
    registry.set(id, kits);
  }
  for (const mission of missions) {
    await openRelease(page, '?mission=' + encodeURIComponent(mission));
    await page.locator('#mission-loading-start').click({ timeout: 25_000 });
    const posts = await sceneReady(page);
    const drawings = JSON.parse(await page.locator('#scene').getAttribute('data-unit-drawings'));
    for (const [id, frames] of Object.entries(drawings)) {
      if (separateAttackCards.has(id)) {
        assert.equal(frames.length, 7, `Missing movement or attack drawings in ${mission}: ${id}`);
        record(units, id, mission, frames.slice(0, 6));
        record(units, id + '-attack', mission, frames.slice(6));
      } else {
        record(units, id, mission, frames);
      }
    }
    async function recordPosts(entries) {
      const drawn = await page.evaluate(readGarrison, entries);
      for (const { id, frames } of drawn) {
        const rendered = await page.evaluate(renderFrames, { groups: frames.map(frame => [frame]), cell });
        record(game, id, mission, rendered);
      }
    }
    await recordPosts(posts.filter(post => post.shown));
    const heroes = page.locator('#fortress .welcome-hero, #liberation .welcome-hero');
    for (const hero of await heroes.all()) {
      await hero.locator('img[src]:not([src=""])').last().waitFor({ state: 'attached', timeout: 15_000 });
      const layers = await hero.locator('img').evaluateAll(async images => {
        await Promise.all(images.map(image => image.decode()));
        return images.map(image => ({ source: image.currentSrc }));
      });
      const rendered = await page.evaluate(renderFrames, { groups: [layers], cell, type: 'hero' });
      record(game, 'yudante', mission, rendered);
      heroScenes++;
    }
    // A post revealed later in the siege has no idle animation at the opening.
    // Sample it in the published wave preview immediately before its defeat.
    const laterPosts = Map.groupBy(posts.filter(post => !post.shown), post => post.hit);
    for (const [hit, entries] of laterPosts) {
      assert(Number.isInteger(hit) && hit > 1, `Unexpected hidden opening post in ${mission}: ${entries[0].id}`);
      await openRelease(page, `?editor&review=animation&mission=${encodeURIComponent(mission)}&scene=field&field=${hit}`);
      await sceneReady(page, entries);
      await recordPosts(entries);
      console.log(`${mission} · wave ${hit} · ${entries.map(post => post.id).join(', ')}`);
    }
  }
  assert(missions.length && units.size && game.size && heroScenes, 'Could not discover the current battle cast');
  await openRelease(page, '?editor&catalog');
  const cards = page.locator('button[data-character-id]');
  await cards.first().waitFor();
  const catalog = await cards.evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.characterId, name: node.querySelector('strong').textContent,
  })));
  assert.equal(new Set(catalog.map(card => card.id)).size, catalog.length, 'Duplicate character ID');
  const issues = [];
  const compared = [];
  const catalogOnly = [];
  const catalogIds = new Set(catalog.map(card => card.id));
  const battleOnly = [...game, ...units].filter(([id]) => !catalogIds.has(id === 'cyan' ? 'sorceress' : id))
    .map(([id, variants]) => ({ id, missions: [...new Set(variants.flatMap(kit => kit.missions))] }));
  for (const { id, name } of catalog) {
    const unit = id === 'sorceress' ? 'cyan' : id;
    if (!game.has(id) && !units.has(unit)) {
      catalogOnly.push(name);
      continue;
    }
    const card = page.locator(`button[data-character-id="${id}"]`);
    await card.click();
    await page.locator(frameList).first().waitFor({ timeout: 15_000 });
    try {
      const variants = units.get(unit) ?? game.get(id);
      for (const { frames, missions: locations } of variants) {
        assert(frames.length && frames.every(Boolean), 'Missing live drawings for ' + id);
        if (unit === 'cyan') {
          assert.equal(frames.length, 12, locations.join(', '));
          await checkSorceress(frames);
        } else {
          let expected = frames;
          if (units.has(unit)) {
            const type = unit.endsWith('-attack') ? 'attack-card'
              : fullHeightUnitCards.has(unit) ? 'full-height-unit' : 'unit';
            expected = await page.evaluate(renderFrames, { groups: frames.map(source => [{ source }]), cell, type });
          }
          assert.deepEqual(await compareThumbnails(page, expected), [], locations.join(', '));
        }
      }
      compared.push({ name, frames: variants[0].frames.length,
        occurrences: variants.reduce((sum, kit) => sum + kit.missions.length, 0) });
    } catch (error) {
      issues.push({ name, id, error: error.message, actual: error.actual });
    }
    await page.getByRole('button', { name: 'Все персонажи', exact: true }).click();
  }
  console.log(JSON.stringify({ missions, compared, catalogOnly, battleOnly, issues }, null, 2));
  assert(compared.length > 0, 'No characters were compared');
  assert.deepEqual(battleOnly, [], 'Battle characters are missing their catalog cards');
  assert.deepEqual(issues, [], 'Published game and catalog drawings differ');
}

module.exports = { checkCharacterFrames };

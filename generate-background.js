#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Invalid hex color: ${hex}`);
  const int = parseInt(match[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function withSeedSuffix(filePath, seed) {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}-${seed}${ext}`;
}


function shuffle(rng, array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function rasterizeCenteredLogo(svgBuffer, width, height, fit, offsetX = 0, offsetY = 0) {
  const fitWidth = Math.round(width * fit);
  const fitHeight = Math.round(height * fit);

  const { data, info } = await sharp(svgBuffer, { density: 1200 })
    .resize(fitWidth, fitHeight, { fit: 'inside' })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  const left = Math.max(0, Math.min(width - info.width, Math.round((width - info.width) / 2) + offsetX));
  const top = Math.max(0, Math.min(height - info.height, Math.round((height - info.height) / 2) + offsetY));

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: data, left, top }])
    .png()
    .toBuffer();
}

// Column boundaries only — no segments, no RNG. Reused across all seeds.
function planStrips(width, sliceCount) {
  const strips = [];
  for (let i = 0; i < sliceCount; i++) {
    const left = Math.round((i * width) / sliceCount);
    const right = Math.round(((i + 1) * width) / sliceCount);
    const w = right - left;
    if (w > 0) strips.push({ left, width: w });
  }
  return strips;
}

// Divide each strip into segments with independently randomised cut points.
// Because cuts are drawn from the RNG per strip, adjacent strips have different
// segment boundaries, producing an organic (non-banded) colour layout.
// segmentCount = 1 gives one full-height cell per strip.
function planCells(height, strips, segmentCount, rng) {
  const cells = [];
  for (const strip of strips) {
    if (segmentCount <= 1) {
      cells.push({ ...strip, top: 0, height });
      continue;
    }
    // segmentCount-1 cut points drawn independently for this strip, in [1, height-1]
    const cuts = Array.from(
      { length: segmentCount - 1 },
      () => Math.floor(rng() * (height - 1)) + 1
    ).sort((a, b) => a - b);

    const boundaries = [0, ...cuts, height];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const top = boundaries[i];
      const h = boundaries[i + 1] - top;
      if (h > 0) cells.push({ ...strip, top, height: h });
    }
  }
  return cells;
}

// Count pixels per cell that are NOT covered by the logo (alpha < 128).
// Takes a pre-extracted raw alpha buffer so it can be called synchronously per seed.
function countVisiblePixels(alpha, width, cells) {
  return cells.map(cell => {
    let visible = 0;
    for (let y = cell.top; y < cell.top + cell.height; y++) {
      for (let x = cell.left; x < cell.left + cell.width; x++) {
        if (alpha[y * width + x] < 128) visible++;
      }
    }
    return visible;
  });
}

// Assign one color per cell so that each color's VISIBLE pixel total matches
// the configured percentages as closely as possible.
//
// Cells are processed in a random order (determined by the seed) so the spatial
// layout of colors varies per seed. For each cell, the color still furthest below
// its proportional target is chosen — this greedy weighted-partition accounts for
// the logo covering different amounts in different cells.
function assignColors(cells, visiblePerCell, colorWeights, rng) {
  const totalVisible = visiblePerCell.reduce((a, b) => a + b, 0);
  const totalWeight = colorWeights.reduce((a, b) => a + b, 0);
  // Guard against a fully-opaque logo leaving zero visible pixels.
  const safeTotal = Math.max(totalVisible, 1);
  const targets = colorWeights.map(w => (w / totalWeight) * safeTotal);

  // Random traversal order gives a different spatial color layout per seed
  // without biasing which colors land on which cells.
  const order = shuffle(rng, cells.map((_, i) => i));
  const accumulated = new Array(colorWeights.length).fill(0);
  const colorIndex = new Array(cells.length);

  for (const i of order) {
    // Assign to whichever color is furthest below its visible-pixel target.
    let best = 0;
    for (let k = 1; k < colorWeights.length; k++) {
      if (targets[k] - accumulated[k] > targets[best] - accumulated[best]) best = k;
    }
    colorIndex[i] = best;
    accumulated[best] += visiblePerCell[i];
  }

  return cells.map((cell, i) => ({ ...cell, colorIndex: colorIndex[i] }));
}

// Solid cells covering every pixel of the canvas. Each cell is a rectangle of
// its assigned palette color. The logo is composited on top afterwards, so only
// the visible (non-logo) pixels matter — which is why assignColors accounts for them.
async function buildSolidBackground(width, height, slices, colors) {
  const composites = [];
  for (const slice of slices) {
    const buf = await sharp({
      create: { width: slice.width, height: slice.height, channels: 3, background: colors[slice.colorIndex] },
    })
      .png()
      .toBuffer();
    composites.push({ input: buf, left: slice.left, top: slice.top });
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

// Color separation for one palette color: black rectangles at each cell of that
// color, white everywhere else.
async function extractColorSeparation(width, height, slices, colorIndex) {
  const composites = [];
  for (const slice of slices) {
    if (slice.colorIndex !== colorIndex) continue;
    const black = await sharp({
      create: { width: slice.width, height: slice.height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    composites.push({ input: black, left: slice.left, top: slice.top });
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .grayscale()
    .threshold(128)
    .png()
    .toBuffer();
}

// Logo separation: black = logo, white = not logo.
async function extractLogoSeparation(logoLayer) {
  return sharp(logoLayer)
    .extractChannel(3)
    .threshold(128)
    .negate()
    .png()
    .toBuffer();
}

// Background strip separation for one color, with the logo area removed.
// lighten(max) with negated logo: logo pixels become white (removed from this separation).
async function extractBackgroundColorSeparation(width, height, slices, colorIndex, logoSepBuffer) {
  const colorBuffer = await extractColorSeparation(width, height, slices, colorIndex);
  const negLogo = await sharp(logoSepBuffer).negate({ alpha: false }).png().toBuffer();
  return sharp(colorBuffer)
    .composite([{ input: negLogo, blend: 'lighten' }])
    .grayscale()
    .threshold(128)
    .png()
    .toBuffer();
}

async function expandCanvas(buffer, canvasWidth, canvasHeight, background) {
  return sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background },
  })
    .composite([{ input: buffer, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function generateVariant(ctx, seed, seedIndex, isBatch) {
  const { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer, strips, alpha, segmentCount, canvas, naming, padLen } = ctx;

  const rng = mulberry32(seed);
  // Segment cuts are drawn from the RNG per strip, so layout varies per seed.
  const cells = planCells(height, strips, segmentCount, rng);
  const visiblePerCell = countVisiblePixels(alpha, width, cells);
  const slices = assignColors(cells, visiblePerCell, colorWeights, rng);

  const bgBuffer = await buildSolidBackground(width, height, slices, colors);

  // Logo recolored with the flat background color, composited on top.
  const logoAlpha = await sharp(logoLayer).extractChannel(3).threshold(128).png().toBuffer();
  const flatColor = await sharp({
    create: { width, height, channels: 3, background },
  })
    .png()
    .toBuffer();
  const coloredLogo = await sharp(flatColor).joinChannel(logoAlpha).png().toBuffer();

  let mainBuffer = await sharp(bgBuffer)
    .composite([{ input: coloredLogo, blend: 'over' }])
    .flatten({ background })
    .png()
    .toBuffer();

  if (canvas.enabled) {
    mainBuffer = await expandCanvas(mainBuffer, canvas.width, canvas.height, { r: 0, g: 0, b: 0, alpha: 0 });
  }

  const batchLabel = naming === 'index'
    ? String(seedIndex + 1).padStart(padLen, '0')
    : String(seed);
  const dstPath = path.resolve(
    baseDir,
    isBatch ? withSeedSuffix(config.output.dst, batchLabel) : config.output.dst
  );
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, mainBuffer);
  const outputSize = canvas.enabled ? `${canvas.width}x${canvas.height}` : `${width}x${height}`;
  console.log(`Generated ${outputSize} background-glitch graphic -> ${dstPath} (seed: ${seed})`);

  const separations = config.output.separations;
  const separationsEnabled = !!separations && separations.enabled !== false;
  if (!separationsEnabled) return;

  const baseSepDir = path.resolve(baseDir, separations.dir);
  const sepDir = isBatch ? path.join(baseSepDir, batchLabel) : baseSepDir;
  fs.mkdirSync(sepDir, { recursive: true });
  const prefix = separations.prefix ?? 'color';

  const logoSepBuffer = await extractLogoSeparation(logoLayer);

  const writeSeparation = async (buffer, outPath) => {
    const final = canvas.enabled
      ? await expandCanvas(buffer, canvas.width, canvas.height, { r: 255, g: 255, b: 255, alpha: 255 })
      : buffer;
    fs.writeFileSync(outPath, final);
    console.log(`Generated color separation -> ${outPath}`);
  };

  // Logo = the background color area for tufting purposes.
  const backgroundHex = config.palette.background.replace('#', '');
  await writeSeparation(logoSepBuffer, path.join(sepDir, `background-${backgroundHex}.png`));

  // Per-color separations: full strip columns, logo area removed.
  for (let i = 0; i < colors.length; i++) {
    const buffer = await extractBackgroundColorSeparation(width, height, slices, i, logoSepBuffer);
    const hex = colorHexes[i].replace('#', '');
    await writeSeparation(buffer, path.join(sepDir, `${prefix}-${i + 1}-${hex}.png`));
  }
}

async function main() {
  const configPath = path.resolve(process.argv[2] || 'config.json');
  const baseDir = path.dirname(configPath);
  const config = loadConfig(configPath);

  const { width, height } = config.output;
  const svgPath = path.resolve(baseDir, config.input.src);

  if (!fs.existsSync(svgPath)) {
    throw new Error(`Input SVG not found: ${svgPath}`);
  }

  const background = hexToRgb(config.palette.background);
  const paletteColors = config.palette.colors;
  if (!Array.isArray(paletteColors) || paletteColors.length === 0) {
    throw new Error('palette.colors must contain at least one color');
  }
  const colorHexes = paletteColors.map((c) => c.hex);
  const colors = colorHexes.map(hexToRgb);
  const colorWeights = paletteColors.map((c) => c.percentage);
  if (colorWeights.some((w) => !(w > 0))) {
    throw new Error('palette.colors entries must have a percentage greater than 0');
  }

  const glitch = {
    sliceCount: config.glitch.sliceCount,
    maxOffset: config.glitch.maxOffset,
    fit: config.glitch.fit ?? 0.85,
    segments: {
      enabled: config.glitch.segments?.enabled ?? false,
      segmentCount: config.glitch.segments?.segmentCount ?? 5,
      maxOffset: config.glitch.segments?.maxOffset ?? 8,
    },
  };

  const { canvasWidth, canvasHeight, canvasEnabled } = config.output;
  if ((canvasWidth == null) !== (canvasHeight == null)) {
    throw new Error('output.canvasWidth and output.canvasHeight must both be set together');
  }
  const hasCanvasSize = canvasWidth != null && canvasHeight != null;
  const canvas = {
    enabled: hasCanvasSize && canvasEnabled !== false,
    width: canvasWidth,
    height: canvasHeight,
  };

  const isBatch = Array.isArray(config.glitch.seeds) && config.glitch.seeds.length > 0;
  const seeds = isBatch ? config.glitch.seeds : [config.glitch.seed ?? Date.now()];
  const naming = config.output.naming ?? 'seed';
  const padLen = String(seeds.length).length;

  const offsetX = config.input.offsetX ?? 0;
  const offsetY = config.input.offsetY ?? 0;

  const svgBuffer = fs.readFileSync(svgPath);
  const logoLayer = await rasterizeCenteredLogo(svgBuffer, width, height, glitch.fit, offsetX, offsetY);

  // Strip column positions and logo alpha are fixed across all seeds — compute once.
  const strips = planStrips(width, glitch.sliceCount);
  const alpha = await sharp(logoLayer).extractChannel(3).raw().toBuffer();
  const segmentCount = glitch.segments.enabled ? glitch.segments.segmentCount : 1;

  const ctx = { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer, strips, alpha, segmentCount, canvas, naming, padLen };
  for (let i = 0; i < seeds.length; i++) {
    await generateVariant(ctx, seeds[i], i, isBatch);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

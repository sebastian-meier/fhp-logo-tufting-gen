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

// Deterministic PRNG so a given seed always reproduces the same glitch pattern.
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

// Inserts "-<seed>" before a file's extension, e.g. "out.png" -> "out-42.png".
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

// Splits sliceCount slots among colors in proportion to their weights, using
// largest-remainder rounding so the totals add up to exactly sliceCount even
// when the percentages don't divide evenly.
function allocateColorCounts(sliceCount, weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const raw = weights.map((w) => (w / total) * sliceCount);
  const counts = raw.map(Math.floor);
  const remainder = sliceCount - counts.reduce((sum, c) => sum + c, 0);

  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remainder; i++) {
    counts[order[i % order.length].index]++;
  }
  return counts;
}

async function rasterizeCenteredLogo(svgBuffer, width, height, fit) {
  const fitWidth = Math.round(width * fit);
  const fitHeight = Math.round(height * fit);

  // Rasterize at a generous density so the small vector logo stays crisp
  // once sharp scales it down to fit inside the canvas.
  const { data, info } = await sharp(svgBuffer, { density: 1200 })
    .resize(fitWidth, fitHeight, { fit: 'inside' })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  const left = Math.round((width - info.width) / 2);
  const top = Math.round((height - info.height) / 2);

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: data, left, top }])
    .png()
    .toBuffer();
}

// One slice plan shared by the colored composite and the color separations,
// so the separations line up exactly with what's visible in the combined image.
// Each color is given an exact share of the slices (per colorWeights), then the
// assignment is shuffled so same-colored slices don't clump together.
function planSlices(width, sliceCount, maxOffset, colorWeights, rng) {
  const counts = allocateColorCounts(sliceCount, colorWeights);
  const colorPool = [];
  counts.forEach((count, colorIndex) => {
    for (let k = 0; k < count; k++) colorPool.push(colorIndex);
  });
  const colorOrder = shuffle(rng, colorPool);

  const slices = [];
  let poolIndex = 0;
  for (let i = 0; i < sliceCount; i++) {
    const left = Math.round((i * width) / sliceCount);
    const right = Math.round(((i + 1) * width) / sliceCount);
    const sliceWidth = right - left;
    const colorIndex = colorOrder[poolIndex++];
    if (sliceWidth <= 0) continue;
    slices.push({
      left,
      width: sliceWidth,
      colorIndex,
      offset: randInt(rng, -maxOffset, maxOffset),
    });
  }
  return slices;
}

async function colorizeSlice(sliceAlphaBuffer, sliceWidth, height, color) {
  const flatColor = await sharp({
    create: { width: sliceWidth, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  return sharp(flatColor).joinChannel(sliceAlphaBuffer).png().toBuffer();
}

async function buildGlitchedLogo(logoLayer, width, height, maxOffset, slices, colors) {
  const paddedHeight = height + 2 * maxOffset;

  const composites = [];
  for (const slice of slices) {
    const sliceAlpha = await sharp(logoLayer)
      .extract({ left: slice.left, top: 0, width: slice.width, height })
      .extractChannel(3)
      .png()
      .toBuffer();

    const coloredSlice = await colorizeSlice(sliceAlpha, slice.width, height, colors[slice.colorIndex]);
    composites.push({ input: coloredSlice, left: slice.left, top: maxOffset + slice.offset });
  }

  const padded = await sharp({
    create: { width, height: paddedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return sharp(padded).extract({ left: 0, top: maxOffset, width, height });
}

// Single source of truth for "is this pixel part of the glitched logo at all".
// A pure black/white mask (hard threshold, no antialiasing): black = shape, white = background.
// Every per-color and background separation is sliced from this one mask, so they
// can never disagree with each other at a given pixel.
async function buildShapeMask(logoLayer, width, height, maxOffset, slices) {
  const paddedHeight = height + 2 * maxOffset;

  const composites = [];
  for (const slice of slices) {
    const mask = await sharp(logoLayer)
      .extract({ left: slice.left, top: 0, width: slice.width, height })
      .extractChannel(3)
      .threshold(128) // snap to pure 0/255, eliminating SVG/PNG antialiasing
      .negate() // shape -> black (0), background -> white (255)
      .png()
      .toBuffer();

    composites.push({ input: mask, left: slice.left, top: maxOffset + slice.offset });
  }

  const padded = await sharp({
    create: { width, height: paddedHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .grayscale()
    .threshold(128)
    .png()
    .toBuffer();

  return sharp(padded).extract({ left: 0, top: maxOffset, width, height }).png().toBuffer();
}

// Restricts the shared shape mask to only the columns assigned to one color,
// blanking every other column to white. Since each column belongs to exactly
// one color's slice, this can never overlap with another color's separation.
async function extractColorSeparation(shapeMask, width, height, slices, colorIndex) {
  const composites = [];
  for (const slice of slices) {
    if (slice.colorIndex !== colorIndex) continue;
    const crop = await sharp(shapeMask)
      .extract({ left: slice.left, top: 0, width: slice.width, height })
      .png()
      .toBuffer();
    composites.push({ input: crop, left: slice.left, top: 0 });
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

// The complement of the shape mask: black wherever no color slice is present,
// i.e. exactly where the background color shows through.
async function extractBackgroundSeparation(shapeMask) {
  return sharp(shapeMask).negate({ alpha: false }).png().toBuffer();
}

async function generateVariant(ctx, seed, isBatch) {
  const { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer } = ctx;

  const rng = mulberry32(seed);
  const slices = planSlices(width, glitch.sliceCount, glitch.maxOffset, colorWeights, rng);

  const dstPath = path.resolve(
    baseDir,
    isBatch ? withSeedSuffix(config.output.dst, seed) : config.output.dst
  );
  const glitched = await buildGlitchedLogo(logoLayer, width, height, glitch.maxOffset, slices, colors);
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  await glitched.flatten({ background }).png().toFile(dstPath);
  console.log(`Generated ${width}x${height} glitch graphic -> ${dstPath} (seed: ${seed})`);

  const separations = config.output.separations;
  const separationsEnabled = !!separations && separations.enabled !== false;
  if (separationsEnabled) {
    const baseSepDir = path.resolve(baseDir, separations.dir);
    const sepDir = isBatch ? path.join(baseSepDir, String(seed)) : baseSepDir;
    fs.mkdirSync(sepDir, { recursive: true });
    const prefix = separations.prefix ?? 'color';

    const shapeMask = await buildShapeMask(logoLayer, width, height, glitch.maxOffset, slices);

    const backgroundHex = config.palette.background.replace('#', '');
    const backgroundBuffer = await extractBackgroundSeparation(shapeMask);
    const backgroundPath = path.join(sepDir, `background-${backgroundHex}.png`);
    fs.writeFileSync(backgroundPath, backgroundBuffer);
    console.log(`Generated color separation -> ${backgroundPath}`);

    for (let i = 0; i < colors.length; i++) {
      const buffer = await extractColorSeparation(shapeMask, width, height, slices, i);
      const hex = colorHexes[i].replace('#', '');
      const outPath = path.join(sepDir, `${prefix}-${i + 1}-${hex}.png`);
      fs.writeFileSync(outPath, buffer);
      console.log(`Generated color separation -> ${outPath}`);
    }
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
  };

  const isBatch = Array.isArray(config.glitch.seeds) && config.glitch.seeds.length > 0;
  const seeds = isBatch ? config.glitch.seeds : [config.glitch.seed ?? Date.now()];

  const svgBuffer = fs.readFileSync(svgPath);
  // Rasterizing the SVG is independent of the seed, so it's done once and reused
  // across every variant in a batch run.
  const logoLayer = await rasterizeCenteredLogo(svgBuffer, width, height, glitch.fit);

  const ctx = { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer };
  for (const seed of seeds) {
    await generateVariant(ctx, seed, isBatch);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

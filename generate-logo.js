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

async function rasterizeCenteredLogo(svgBuffer, width, height, fit, offsetX = 0, offsetY = 0) {
  const fitWidth = Math.round(width * fit);
  const fitHeight = Math.round(height * fit);

  // Rasterize at a generous density so the small vector logo stays crisp
  // once sharp scales it down to fit inside the canvas.
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

// Splits a strip's height into segmentsCfg.segmentCount horizontal segments,
// each with its own y-axis offset. When disabled, returns a single full-height
// segment with zero offset so the calling code stays uniform.
function planSegments(height, segmentsCfg, rng) {
  if (!segmentsCfg.enabled) {
    return [{ top: 0, height, offset: 0 }];
  }
  const count = segmentsCfg.segmentCount;
  const maxOff = segmentsCfg.maxOffset;
  const segs = [];
  for (let i = 0; i < count; i++) {
    const top = Math.round((i * height) / count);
    const bottom = Math.round(((i + 1) * height) / count);
    const h = bottom - top;
    if (h <= 0) continue;
    segs.push({ top, height: h, offset: randInt(rng, -maxOff, maxOff) });
  }
  return segs;
}

// One slice plan shared by the colored composite and the color separations,
// so the separations line up exactly with what's visible in the combined image.
// Each color is given an exact share of the slices (per colorWeights), then the
// assignment is shuffled so same-colored slices don't clump together.
function planSlices(width, height, sliceCount, maxOffset, segmentsCfg, colorWeights, rng) {
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
      segments: planSegments(height, segmentsCfg, rng),
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

async function buildGlitchedLogo(logoLayer, width, height, totalMaxOffset, slices, colors, cropTop) {
  const paddedHeight = height + 2 * totalMaxOffset;

  const composites = [];
  for (const slice of slices) {
    for (const seg of slice.segments) {
      const segAlpha = await sharp(logoLayer)
        .extract({ left: slice.left, top: seg.top, width: slice.width, height: seg.height })
        .extractChannel(3)
        .threshold(128)
        .png()
        .toBuffer();

      const coloredSeg = await colorizeSlice(segAlpha, slice.width, seg.height, colors[slice.colorIndex]);
      composites.push({
        input: coloredSeg,
        left: slice.left,
        top: totalMaxOffset + slice.offset + seg.top + seg.offset,
      });
    }
  }

  const padded = await sharp({
    create: { width, height: paddedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return sharp(padded).extract({ left: 0, top: cropTop, width, height });
}

// Single source of truth for "is this pixel part of the glitched logo at all".
// A pure black/white mask (hard threshold, no antialiasing): black = shape, white = background.
// Every per-color and background separation is sliced from this one mask, so they
// can never disagree with each other at a given pixel. Built at the full padded
// height (before the final centered crop) so its bounding box can be measured.
async function buildPaddedShapeMask(logoLayer, width, height, totalMaxOffset, slices) {
  const paddedHeight = height + 2 * totalMaxOffset;

  const composites = [];
  for (const slice of slices) {
    for (const seg of slice.segments) {
      const mask = await sharp(logoLayer)
        .extract({ left: slice.left, top: seg.top, width: slice.width, height: seg.height })
        .extractChannel(3)
        .threshold(128)
        .negate()
        .png()
        .toBuffer();

      composites.push({
        input: mask,
        left: slice.left,
        top: totalMaxOffset + slice.offset + seg.top + seg.offset,
      });
    }
  }

  return sharp({
    create: { width, height: paddedHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .grayscale()
    .threshold(128)
    .png()
    .toBuffer();
}

// The crop window is normally centered on the canvas, but a run of offsets
// skewed mostly up or down shifts the glitched shape's actual ink off-center.
// Finding the real ink bounding box (via trim) and centering the crop on its
// midpoint keeps the glitch visually centered regardless of which offsets
// were rolled, instead of assuming every slice's ink spans its full height.
async function computeCenteredCropTop(paddedShapeMask, height, paddedHeight) {
  const { info } = await sharp(paddedShapeMask).trim().toBuffer({ resolveWithObject: true });
  const contentTop = -info.trimOffsetTop;
  const midpoint = contentTop + info.height / 2;
  const cropTop = Math.round(midpoint - height / 2);
  return Math.max(0, Math.min(paddedHeight - height, cropTop));
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

// Pastes a width x height image into the upper-left corner of a larger
// canvasWidth x canvasHeight canvas. The extra margin is filled with
// `background` — transparent for the main image, white for separations.
async function expandCanvas(buffer, canvasWidth, canvasHeight, background) {
  return sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background },
  })
    .composite([{ input: buffer, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function generateVariant(ctx, seed, seedIndex, isBatch) {
  const { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer, canvas, naming, padLen } = ctx;

  const rng = mulberry32(seed);
  const totalMaxOffset = glitch.maxOffset + (glitch.segments.enabled ? glitch.segments.maxOffset : 0);
  const slices = planSlices(width, height, glitch.sliceCount, glitch.maxOffset, glitch.segments, colorWeights, rng);

  const paddedHeight = height + 2 * totalMaxOffset;
  const paddedShapeMask = await buildPaddedShapeMask(logoLayer, width, height, totalMaxOffset, slices);
  const cropTop = await computeCenteredCropTop(paddedShapeMask, height, paddedHeight);

  const batchLabel = naming === 'index'
    ? String(seedIndex + 1).padStart(padLen, '0')
    : String(seed);
  const dstPath = path.resolve(
    baseDir,
    isBatch ? withSeedSuffix(config.output.dst, batchLabel) : config.output.dst
  );
  const glitched = await buildGlitchedLogo(logoLayer, width, height, totalMaxOffset, slices, colors, cropTop);
  let mainBuffer = await glitched.flatten({ background }).png().toBuffer();
  if (canvas.enabled) {
    mainBuffer = await expandCanvas(mainBuffer, canvas.width, canvas.height, { r: 0, g: 0, b: 0, alpha: 0 });
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, mainBuffer);
  const outputSize = canvas.enabled ? `${canvas.width}x${canvas.height}` : `${width}x${height}`;
  console.log(`Generated ${outputSize} glitch graphic -> ${dstPath} (seed: ${seed})`);

  const separations = config.output.separations;
  const separationsEnabled = !!separations && separations.enabled !== false;
  if (separationsEnabled) {
    const baseSepDir = path.resolve(baseDir, separations.dir);
    const sepDir = isBatch ? path.join(baseSepDir, batchLabel) : baseSepDir;
    fs.mkdirSync(sepDir, { recursive: true });
    const prefix = separations.prefix ?? 'color';

    const shapeMask = await sharp(paddedShapeMask)
      .extract({ left: 0, top: cropTop, width, height })
      .png()
      .toBuffer();

    const writeSeparation = async (buffer, outPath) => {
      const final = canvas.enabled
        ? await expandCanvas(buffer, canvas.width, canvas.height, { r: 255, g: 255, b: 255, alpha: 255 })
        : buffer;
      fs.writeFileSync(outPath, final);
      console.log(`Generated color separation -> ${outPath}`);
    };

    const backgroundHex = config.palette.background.replace('#', '');
    const backgroundBuffer = await extractBackgroundSeparation(shapeMask);
    await writeSeparation(backgroundBuffer, path.join(sepDir, `background-${backgroundHex}.png`));

    for (let i = 0; i < colors.length; i++) {
      const buffer = await extractColorSeparation(shapeMask, width, height, slices, i);
      const hex = colorHexes[i].replace('#', '');
      await writeSeparation(buffer, path.join(sepDir, `${prefix}-${i + 1}-${hex}.png`));
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
  // Rasterizing the SVG is independent of the seed, so it's done once and reused
  // across every variant in a batch run.
  const logoLayer = await rasterizeCenteredLogo(svgBuffer, width, height, glitch.fit, offsetX, offsetY);

  const ctx = { baseDir, config, width, height, background, colors, colorHexes, colorWeights, glitch, logoLayer, canvas, naming, padLen };
  for (let i = 0; i < seeds.length; i++) {
    await generateVariant(ctx, seeds[i], i, isBatch);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

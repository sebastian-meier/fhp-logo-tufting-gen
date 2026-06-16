#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SEED = 1_000_000;

function generateUniqueSeeds(count, max) {
  if (count > max) {
    throw new Error(`Cannot generate ${count} unique seeds from a range of ${max}`);
  }
  const seeds = new Set();
  while (seeds.size < count) {
    seeds.add(crypto.randomInt(0, max));
  }
  return [...seeds];
}

function main() {
  const count = parseInt(process.argv[2], 10);
  if (!Number.isInteger(count) || count <= 0) {
    console.error('Usage: node seeds.js <count> [configPath]');
    process.exit(1);
  }

  const configPath = path.resolve(process.argv[3] || 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw); // validates the file is well-formed JSON first
  if (!config.glitch) {
    throw new Error('config.json has no "glitch" object to add seeds to');
  }

  const seeds = generateUniqueSeeds(count, MAX_SEED);
  const seedsPattern = /"seeds"\s*:\s*\[[^\]]*\]/;

  // Replace the seeds array in place, in the raw text, so the rest of the
  // file's formatting (indentation, single-line objects, etc.) is untouched.
  let updated;
  if (seedsPattern.test(raw)) {
    updated = raw.replace(seedsPattern, `"seeds": [${seeds.join(', ')}]`);
  } else {
    updated = raw.replace(/"glitch"\s*:\s*\{/, (match) => `${match}\n        "seeds": [${seeds.join(', ')}],`);
  }

  fs.writeFileSync(configPath, updated);
  console.log(`Wrote ${count} seed(s) to ${configPath}:`);
  console.log(seeds.join(', '));
}

main();

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function main() {
  const configPath = path.resolve(process.argv[2] || 'config.json');
  const baseDir = path.dirname(configPath);
  const config = loadConfig(configPath);

  let removed = 0;

  // Matches both the single-seed "output.png" and batch variants like "output-1234.png".
  const dstPath = path.resolve(baseDir, config.output.dst);
  const dstDir = path.dirname(dstPath);
  const ext = path.extname(dstPath);
  const base = path.basename(dstPath, ext);

  if (fs.existsSync(dstDir)) {
    for (const file of fs.readdirSync(dstDir)) {
      const isBaseFile = file === `${base}${ext}`;
      const isSeededVariant = file.startsWith(`${base}-`) && file.endsWith(ext);
      if (isBaseFile || isSeededVariant) {
        fs.unlinkSync(path.join(dstDir, file));
        console.log(`Removed ${path.join(dstDir, file)}`);
        removed++;
      }
    }
  }

  const separations = config.output.separations;
  if (separations) {
    const sepDir = path.resolve(baseDir, separations.dir);
    if (fs.existsSync(sepDir)) {
      fs.rmSync(sepDir, { recursive: true, force: true });
      console.log(`Removed ${sepDir}`);
      removed++;
    }
  }

  console.log(removed === 0 ? 'Nothing to clean.' : `Done (${removed} item(s) removed).`);
}

main();

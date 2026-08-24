import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compareStyleTokenBaseline,
  DEFAULT_PATTERNS,
  scanStyleTokenDrift,
  validateStyleTokenBaseline,
} from './style-token-drift.mjs';


const rootDir = process.cwd();
const stylesDir = path.resolve(rootDir, 'src/styles');
const baselinePath = path.resolve(rootDir, 'scripts/style-token-drift-baseline.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
validateStyleTokenBaseline(baseline, DEFAULT_PATTERNS);

const { files, hits, counts } = await scanStyleTokenDrift({ rootDir, stylesDir });
const comparison = compareStyleTokenBaseline(counts, baseline);

console.log('Style token drift report');
console.log(`Scanned ${files.length} CSS files. Found ${hits.length} baseline-gated matches.`);
for (const pattern of DEFAULT_PATTERNS) {
  const count = Object.values(counts[pattern.id] ?? {}).reduce((total, value) => total + value, 0);
  console.log(`- ${pattern.label}: ${count}`);
}

if (hits.length > 0) {
  console.log('\nFirst matches:');
  for (const hit of hits.slice(0, 40)) {
    console.log(`- ${hit.file}:${hit.line} ${hit.value}`);
  }
}

if (comparison.reductions.length > 0) {
  console.log('\nBaseline reductions available:');
  for (const item of comparison.reductions) {
    console.log(
      `- ${item.file} ${item.patternId}: ${item.current}/${item.baseline} (${item.delta})`,
    );
  }
}

if (comparison.violations.length > 0) {
  console.error('\nStyle token drift gate failed:');
  for (const item of comparison.violations) {
    console.error(
      `- ${item.file} ${item.patternId}: ${item.current}/${item.baseline} (+${item.delta})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log('\nStyle token drift gate passed.');
}

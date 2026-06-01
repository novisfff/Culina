import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const assetsDir = join(rootDir, 'dist', 'assets');

const trackedBundles = [
  { label: 'main-js', prefix: 'index-', suffix: '.js', gzipBudget: 110 * 1024 },
  { label: 'main-css', prefix: 'index-', suffix: '.css', gzipBudget: 95 * 1024 },
  { label: 'ai-workspace', prefix: 'AiWorkspace-', suffix: '.js', gzipBudget: 7 * 1024 },
  { label: 'family-settings', prefix: 'FamilySettings-', suffix: '.js', gzipBudget: 7 * 1024 },
  { label: 'food-workspace', prefix: 'FoodWorkspace-', suffix: '.js', gzipBudget: 26 * 1024 },
  { label: 'recipe-workspace', prefix: 'RecipeWorkspace-', suffix: '.js', gzipBudget: 36 * 1024 },
  { label: 'ingredient-workspace', prefix: 'IngredientWorkspace-', suffix: '.js', gzipBudget: 37 * 1024 },
];

function formatKilobytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function findBundleFile(prefix, suffix, files) {
  return files.find((file) => file.startsWith(prefix) && file.endsWith(suffix)) ?? null;
}

const assetFiles = readdirSync(assetsDir).filter((file) => !file.startsWith('.'));
const violations = [];

console.log('Bundle gzip budgets:');

for (const bundle of trackedBundles) {
  const matchedFile = findBundleFile(bundle.prefix, bundle.suffix, assetFiles);
  if (!matchedFile) {
    violations.push(`${bundle.label}: missing output matching ${bundle.prefix}*${bundle.suffix}`);
    continue;
  }

  const assetPath = join(assetsDir, matchedFile);
  const gzipSize = gzipSync(readFileSync(assetPath)).byteLength;

  console.log(`- ${bundle.label}: ${matchedFile} ${formatKilobytes(gzipSize)}/${formatKilobytes(bundle.gzipBudget)}`);

  if (gzipSize > bundle.gzipBudget) {
    violations.push(
      `${bundle.label}: ${matchedFile} gzip ${formatKilobytes(gzipSize)} exceeds budget ${formatKilobytes(bundle.gzipBudget)}`
    );
  }
}

if (violations.length > 0) {
  console.error('\nBundle budget check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Bundle budget check passed.');

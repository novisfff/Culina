import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const assetsDir = join(rootDir, 'dist', 'assets');
const imagesDir = join(rootDir, 'dist', 'images');

const trackedBundles = [
  { label: 'main-js', prefix: 'index-', suffix: '.js', gzipBudget: 110 * 1024 },
  { label: 'main-css', prefix: 'index-', suffix: '.css', gzipBudget: 95 * 1024 },
  { label: 'ai-workspace', prefix: 'AiWorkspace-', suffix: '.js', gzipBudget: 7 * 1024 },
  { label: 'family-settings', prefix: 'FamilySettings-', suffix: '.js', gzipBudget: 7 * 1024 },
  { label: 'food-workspace', prefix: 'FoodWorkspace-', suffix: '.js', gzipBudget: 26 * 1024 },
  { label: 'recipe-workspace', prefix: 'RecipeWorkspace-', suffix: '.js', gzipBudget: 36 * 1024 },
  { label: 'ingredient-workspace', prefix: 'IngredientWorkspace-', suffix: '.js', gzipBudget: 37 * 1024 },
];

const publicImageBudget = 1536 * 1024;
const publicImageExtensions = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);
const disallowedPublicFiles = new Set(['.DS_Store']);

function formatKilobytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function findBundleFile(prefix, suffix, files) {
  return files.find((file) => file.startsWith(prefix) && file.endsWith(suffix)) ?? null;
}

function getExtension(file) {
  const dotIndex = file.lastIndexOf('.');
  return dotIndex === -1 ? '' : file.slice(dotIndex).toLowerCase();
}

function checkPublicAssets(dir, label, violations) {
  const files = readdirSync(dir).filter((file) => !file.startsWith('.'));
  const allFiles = readdirSync(dir);

  for (const file of allFiles) {
    if (disallowedPublicFiles.has(file)) {
      violations.push(`${label}/${file}: disallowed public file`);
    }
  }

  for (const file of files) {
    if (!publicImageExtensions.has(getExtension(file))) {
      continue;
    }

    const assetPath = join(dir, file);
    const size = statSync(assetPath).size;
    console.log(`- ${label}/${file}: ${formatKilobytes(size)}/${formatKilobytes(publicImageBudget)}`);

    if (size > publicImageBudget) {
      violations.push(
        `${label}/${file}: ${formatKilobytes(size)} exceeds image budget ${formatKilobytes(publicImageBudget)}`
      );
    }
  }
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

console.log('\nPublic image budgets:');
checkPublicAssets(assetsDir, 'assets', violations);
checkPublicAssets(imagesDir, 'images', violations);

if (violations.length > 0) {
  console.error('\nBundle budget check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Bundle budget check passed.');

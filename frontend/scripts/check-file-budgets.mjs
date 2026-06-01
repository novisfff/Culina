import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const srcDir = resolve(rootDir, 'src');
const maxNewReactFileLines = 1000;
const trackedLargeFiles = new Map([
  ['src/App.tsx', 5000],
  ['src/components/foods/FoodWorkspace.tsx', 3400],
  ['src/components/ingredients/IngredientWorkspace.tsx', 6200],
  ['src/components/recipes/RecipeWorkspace.tsx', 2200],
]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return walk(path);
    }
    return path;
  });
}

function countLines(path) {
  const content = readFileSync(path, 'utf8');
  if (!content) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

const violations = [];
const largeFiles = [];

for (const path of walk(srcDir)) {
  if (!/\.(tsx|ts)$/.test(path) || /\.test\.(tsx|ts)$/.test(path)) {
    continue;
  }

  const relativePath = relative(rootDir, path);
  const lineCount = countLines(path);
  const existingBudget = trackedLargeFiles.get(relativePath);

  if (existingBudget !== undefined) {
    largeFiles.push({ relativePath, lineCount, budget: existingBudget });
    if (lineCount > existingBudget) {
      violations.push(`${relativePath}: ${lineCount} lines exceeds existing budget ${existingBudget}`);
    }
    continue;
  }

  if (path.endsWith('.tsx') && lineCount > maxNewReactFileLines) {
    violations.push(`${relativePath}: ${lineCount} lines exceeds React file budget ${maxNewReactFileLines}`);
  }
}

if (largeFiles.length > 0) {
  console.log('Tracked large-file budgets:');
  for (const item of largeFiles.sort((left, right) => right.lineCount - left.lineCount)) {
    console.log(`- ${item.relativePath}: ${item.lineCount}/${item.budget}`);
  }
}

if (violations.length > 0) {
  console.error('\nFile budget check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('File budget check passed.');

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


export const CANONICAL_CSS_LAYERS = Object.freeze([
  'reset',
  'tokens',
  'primitives',
  'shell',
  'domain',
  'responsive',
  'compatibility',
]);


export function assertCssLayerOrder(cssText, {
  allowedLayers = CANONICAL_CSS_LAYERS,
  source = 'styles.css',
} = {}) {
  const orderStatements = [...cssText.matchAll(/@layer\s+([^;{]+);/g)];
  const violations = [];
  const layers = orderStatements.length === 1
    ? orderStatements[0][1].split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];

  if (orderStatements.length !== 1) {
    violations.push(`${source} must declare the canonical layer order exactly once`);
  }
  if (layers.join(',') !== CANONICAL_CSS_LAYERS.join(',')) {
    violations.push(`${source} must use the canonical layer order: ${CANONICAL_CSS_LAYERS.join(', ')}`);
  }

  const allowed = new Set(allowedLayers);
  for (const match of cssText.matchAll(/@layer\s+([a-zA-Z0-9_-]+)\s*\{/g)) {
    if (!allowed.has(match[1])) {
      violations.push(`${source} must not write layer ${match[1]}`);
    }
  }
  return { layers, violations: [...new Set(violations)].sort() };
}


async function runCli() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.dirname(scriptDir);
  const entrypoint = await readFile(path.join(frontendDir, 'src', 'styles.css'), 'utf8');
  const result = assertCssLayerOrder(entrypoint);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.violations.length > 0) process.exitCode = 1;
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}

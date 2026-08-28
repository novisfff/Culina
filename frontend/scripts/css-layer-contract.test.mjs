import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertCssLayerOrder } from './css-layer-contract.mjs';


const FRONTEND_DIR = path.resolve(import.meta.dirname, '..');
const EXPECTED_ORDER = ['reset', 'tokens', 'primitives', 'shell', 'domain', 'responsive', 'compatibility'];


async function readFrontend(relativeFile) {
  return readFile(path.join(FRONTEND_DIR, relativeFile), 'utf8');
}


describe('CSS cascade layer contract', () => {
  it('declares the canonical layer order exactly once', async () => {
    const entrypoint = await readFrontend('src/styles.css');

    expect(assertCssLayerOrder(entrypoint)).toEqual({
      layers: EXPECTED_ORDER,
      violations: [],
    });
    expect(entrypoint.match(/@layer\s+reset\s*,/g)).toHaveLength(1);
  });

  it('assigns foundation, ui-kit, shell, domain, and responsive imports', async () => {
    const entrypoint = await readFrontend('src/styles.css');

    expect(entrypoint).toContain("@import './styles/00-ui-kit.css' layer(primitives);");
    expect(entrypoint).toContain("@import './styles/legacy-primitives.css' layer(primitives);");
    expect(entrypoint).toContain("@import './styles/shell.css' layer(shell);");
    expect(entrypoint).toContain("@import './styles/01-home-dashboard.css' layer(domain);");
    expect(entrypoint).toContain("@import './styles/07-mobile.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/family-responsive.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/home-responsive.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/recipe-responsive.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/meal-responsive.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/eat-responsive.css' layer(responsive);");
    expect(entrypoint).toContain("@import './styles/shell-responsive.css' layer(responsive);");
  });

  it('keeps only reset and tokens in foundation and shell rules in shell.css', async () => {
    const [foundation, shell] = await Promise.all([
      readFrontend('src/styles/00-foundation.css'),
      readFrontend('src/styles/shell.css'),
    ]);

    expect(foundation).toMatch(/@layer\s+tokens\s*\{[\s\S]*:root\s*\{/);
    expect(foundation).toMatch(/@layer\s+reset\s*\{[\s\S]*box-sizing:\s*border-box/);
    expect(foundation).not.toMatch(/\.app-shell\s*\{/);
    expect(shell).toMatch(/\.app-shell\s*\{/);
    expect(shell).toMatch(/\.app-notification-center\s*\{/);
    expect(shell).not.toMatch(/\.workspace-modal\s*\{/);
  });

  it('rejects duplicate, reordered, and forbidden business layers', () => {
    expect(assertCssLayerOrder('@layer reset, tokens, domain;')).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/canonical layer order/)]),
    });
    expect(assertCssLayerOrder(`
      @layer reset, tokens, primitives, shell, domain, responsive, compatibility;
      @layer reset, tokens, primitives, shell, domain, responsive, compatibility;
    `)).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/exactly once/)]),
    });
    expect(assertCssLayerOrder('@layer tokens { .home-card { color: red; } }', {
      allowedLayers: ['domain'],
      source: '01-home-dashboard.css',
    })).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/must not write layer tokens/)]),
    });
  });
});

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadStyleExceptions,
  loadStyleTokenContract,
  scanCssTokens,
  validateRuntimeVariable,
} from './style-contract.mjs';


const FUTURE_EXPIRY = '2099-12-31';


function token(value, category = 'color') {
  return {
    category,
    value,
    source: 'frontend/src/styles/00-foundation.css',
    consumers: ['frontend/src/styles/example.css'],
  };
}


function contract(overrides = {}) {
  return {
    version: 1,
    canonicalSource: 'frontend/src/styles/00-foundation.css',
    tokens: {
      '--radius-sm': token('10px', 'radius'),
      '--brand-button-radius': token('var(--radius-sm)', 'radius'),
      '--color-text': token('#25312b'),
    },
    aliases: {},
    runtimeVariables: {},
    ...overrides,
  };
}


async function createFixture(files) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'culina-style-contract-'));
  const stylesDir = path.join(rootDir, 'frontend', 'src', 'styles');
  await mkdir(stylesDir, { recursive: true });
  await Promise.all(Object.entries(files).map(async ([relativeFile, content]) => {
    const file = path.join(rootDir, relativeFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }));
  return { rootDir, stylesDir };
}


describe('canonical style token contract', () => {
  it('accepts canonical foundation tokens', async () => {
    const configured = contract();
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': `
        :root {
          --radius-sm: 10px;
          --brand-button-radius: var(--radius-sm);
          --color-text: #25312b;
        }
      `,
      'frontend/src/styles/example.css': '.card { color: var(--color-text); border-radius: var(--brand-button-radius); }',
    });

    const result = await scanCssTokens({ rootDir, stylesDir, contract: configured });

    expect(result.drift).toEqual([]);
    expect(result.undefinedVariables).toEqual([]);
    expect(result.references.map(({ variable, classification }) => ({ variable, classification }))).toEqual([
      { variable: '--color-text', classification: 'canonical' },
      { variable: '--brand-button-radius', classification: 'canonical' },
    ]);
  });

  it('rejects brand button radius drift', async () => {
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': `
        :root {
          --radius-sm: 10px;
          --brand-button-radius: 24px;
          --color-text: #25312b;
        }
      `,
    });

    const result = await scanCssTokens({ rootDir, stylesDir, contract: contract() });

    expect(result.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({
        variable: '--brand-button-radius',
        classification: 'definition-drift',
        expected: 'var(--radius-sm)',
        actual: '24px',
      }),
    ]));
  });

  it('treats var fallback as safe but still reports noncanonical use', async () => {
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': ':root { --radius-sm: 10px; --brand-button-radius: var(--radius-sm); --color-text: #25312b; }',
      'frontend/src/styles/example.css': '.card { inset: var(--unknown, 0); }',
    });

    const result = await scanCssTokens({ rootDir, stylesDir, contract: contract() });

    expect(result.undefinedVariables).toEqual([]);
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ variable: '--unknown', classification: 'fallback-safe' }),
    ]));
    expect(result.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ variable: '--unknown', classification: 'noncanonical-reference' }),
    ]));
  });

  it('requires owner and expiry for aliases and runtime variables', async () => {
    const configured = contract({
      aliases: {
        '--text-main': {
          target: '--color-text',
          owner: 'foundation',
          reason: 'Compatibility during CSS migration',
          introducedAt: '2026-08-27',
          expiresAt: '2026-08-27',
          replacement: '--color-text',
          test: 'style-contract.test.mjs',
        },
      },
      runtimeVariables: {
        '--model-usage-share': {
          owner: 'model-usage',
          source: 'frontend/src/features/model-usage/ModelUsageView.tsx',
          fallback: '0',
          consumers: ['frontend/src/styles/14-model-usage.css'],
          introducedAt: '2026-08-27',
          expiresAt: FUTURE_EXPIRY,
          test: 'ModelUsageView.test.tsx',
        },
      },
    });
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': ':root { --radius-sm: 10px; --brand-button-radius: var(--radius-sm); --color-text: #25312b; }',
      'frontend/src/styles/example.css': '.legacy { color: var(--text-main); inline-size: var(--model-usage-share, 0); }',
      'frontend/src/features/model-usage/ModelUsageView.tsx': `const style = { '--model-usage-share': share };`,
    });

    expect(() => validateRuntimeVariable({
      source: 'view.tsx',
      fallback: '0',
      consumers: ['view.css'],
      introducedAt: '2026-08-27',
      test: 'view.test.tsx',
    })).toThrow(/owner/);
    expect(() => validateRuntimeVariable({
      owner: 'view',
      source: 'view.tsx',
      fallback: '0',
      consumers: ['view.css'],
      introducedAt: '2026-08-27',
      test: 'view.test.tsx',
    })).toThrow(/expiresAt/);

    await expect(loadStyleTokenContract(
      await writeContractFixture(contract({
        aliases: {
          '--legacy': {
            target: '--color-text',
            reason: 'Missing owner fixture',
            introducedAt: '2026-08-27',
            expiresAt: FUTURE_EXPIRY,
            replacement: '--color-text',
            test: 'style-contract.test.mjs',
          },
        },
      })),
    )).rejects.toThrow(/owner/);

    const result = await scanCssTokens({ rootDir, stylesDir, contract: configured });
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ variable: '--model-usage-share', classification: 'runtime-allowed', owner: 'model-usage' }),
    ]));
    expect(result.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ variable: '--text-main', classification: 'expired-alias' }),
    ]));
  });

  it('rejects an unregistered inline runtime variable', async () => {
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': ':root { --radius-sm: 10px; --brand-button-radius: var(--radius-sm); --color-text: #25312b; }',
      'frontend/src/components/Example.tsx': `const style = { '--unregistered-inline': value };`,
    });

    const result = await scanCssTokens({ rootDir, stylesDir, contract: contract() });

    expect(result.undefinedVariables).toEqual(expect.arrayContaining([
      expect.objectContaining({
        variable: '--unregistered-inline',
        file: 'frontend/src/components/Example.tsx',
        classification: 'undefined',
      }),
    ]));
  });

  it('ignores comments, strings, and custom property definitions as references', async () => {
    const { rootDir, stylesDir } = await createFixture({
      'frontend/src/styles/00-foundation.css': `
        /* var(--comment-only) */
        :root {
          --radius-sm: 10px;
          --brand-button-radius: var(--radius-sm);
          --color-text: #25312b;
          --definition-only: 1px;
        }
        .example::before { content: "var(--string-only)"; }
      `,
    });

    const result = await scanCssTokens({ rootDir, stylesDir, contract: contract() });

    expect(result.references.map((entry) => entry.variable)).not.toEqual(expect.arrayContaining([
      '--comment-only',
      '--string-only',
      '--definition-only',
    ]));
  });

  it('loads and validates a JSON contract', async () => {
    const { rootDir } = await createFixture({
      'frontend/scripts/style-token-contract.json': `${JSON.stringify(contract(), null, 2)}\n`,
    });

    await expect(loadStyleTokenContract(
      path.join(rootDir, 'frontend/scripts/style-token-contract.json'),
    )).resolves.toMatchObject({ version: 1 });
  });

  it('rejects incomplete, expired, and consumerless style exceptions', async () => {
    const valid = {
      metric: 'important',
      selectorOrValue: '.legacy !important',
      owner: 'compatibility',
      reason: 'Historical override awaiting migration',
      introducedAt: '2026-08-27',
      expiresAt: FUTURE_EXPIRY,
      replacement: 'owned cascade layer',
      test: 'style-contract.test.mjs',
      consumers: ['src/styles/legacy.css'],
    };
    const { rootDir } = await createFixture({
      'valid.json': `${JSON.stringify({ version: 1, exceptions: [valid] })}\n`,
      'missing-owner.json': `${JSON.stringify({ version: 1, exceptions: [{ ...valid, owner: '' }] })}\n`,
      'expired.json': `${JSON.stringify({ version: 1, exceptions: [{ ...valid, expiresAt: '2026-08-27' }] })}\n`,
      'consumerless.json': `${JSON.stringify({ version: 1, exceptions: [{ ...valid, consumers: [] }] })}\n`,
    });

    await expect(loadStyleExceptions(path.join(rootDir, 'valid.json'), { today: '2026-08-28' })).resolves.toHaveLength(1);
    await expect(loadStyleExceptions(path.join(rootDir, 'missing-owner.json'), { today: '2026-08-28' })).rejects.toThrow(/owner/);
    await expect(loadStyleExceptions(path.join(rootDir, 'expired.json'), { today: '2026-08-28' })).rejects.toThrow(/expired/);
    await expect(loadStyleExceptions(path.join(rootDir, 'consumerless.json'), { today: '2026-08-28' })).rejects.toThrow(/consumers/);
  });
});


async function writeContractFixture(configured) {
  const { rootDir } = await createFixture({
    'frontend/scripts/style-token-contract.json': `${JSON.stringify(configured, null, 2)}\n`,
  });
  return path.join(rootDir, 'frontend/scripts/style-token-contract.json');
}

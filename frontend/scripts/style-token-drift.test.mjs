import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PATTERNS,
  compareStyleTokenBaseline,
  scanStyleTokenDrift,
  validateStyleTokenBaseline,
} from './style-token-drift.mjs';


async function createStyleRoot(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'culina-style-drift-'));
  const stylesDir = path.join(root, 'src', 'styles');
  await mkdir(stylesDir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const file = path.join(stylesDir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }),
  );
  return { root, stylesDir };
}


function baseline(allowedByRule) {
  return { version: 1, allowedByRule };
}


describe('style token drift baseline', () => {
  it('passes the baseline and reports reductions without requiring line stability', async () => {
    const { root, stylesDir } = await createStyleRoot({
      'a.css': '.a { border-radius: 13px; color: rgba(0, 0, 0, 0.3); }',
    });
    const current = await scanStyleTokenDrift({ rootDir: root, stylesDir });
    const configured = baseline({
      'radius-13px': { 'src/styles/a.css': 2 },
      'radius-17px': {},
      'black-rgba': { 'src/styles/a.css': 1 },
    });

    validateStyleTokenBaseline(configured, DEFAULT_PATTERNS);
    const comparison = compareStyleTokenBaseline(current.counts, configured);

    expect(comparison.violations).toEqual([]);
    expect(comparison.reductions).toEqual([
      {
        patternId: 'radius-13px',
        file: 'src/styles/a.css',
        baseline: 2,
        current: 1,
        delta: -1,
      },
    ]);
  });

  it('fails increases in an existing file and hits in a new file', async () => {
    const { root, stylesDir } = await createStyleRoot({
      'a.css': '.a { border-radius: 13px; } .b { border-radius: 13px; }',
      'nested/b.css': '.b { color: rgba(0, 0, 0, 0.2); }',
    });
    const current = await scanStyleTokenDrift({ rootDir: root, stylesDir });
    const configured = baseline({
      'radius-13px': { 'src/styles/a.css': 1 },
      'radius-17px': {},
      'black-rgba': {},
    });

    const comparison = compareStyleTokenBaseline(current.counts, configured);

    expect(comparison.violations).toEqual([
      {
        patternId: 'black-rgba',
        file: 'src/styles/nested/b.css',
        baseline: 0,
        current: 1,
        delta: 1,
      },
      {
        patternId: 'radius-13px',
        file: 'src/styles/a.css',
        baseline: 1,
        current: 2,
        delta: 1,
      },
    ]);
  });

  it('rejects unknown rules, unsafe paths, and invalid counts', () => {
    expect(() => validateStyleTokenBaseline(
      baseline({
        'radius-13px': { '../outside.css': -1 },
        'radius-17px': {},
        'black-rgba': {},
        unknown: {},
      }),
      DEFAULT_PATTERNS,
    )).toThrow(/unknown pattern id: unknown/);

    expect(() => validateStyleTokenBaseline(
      baseline({
        'radius-13px': { '../outside.css': 1 },
        'radius-17px': {},
        'black-rgba': {},
      }),
      DEFAULT_PATTERNS,
    )).toThrow(/invalid CSS path/);

    expect(() => validateStyleTokenBaseline(
      baseline({
        'radius-13px': { 'src/styles/a.css': -1 },
        'radius-17px': {},
        'black-rgba': {},
      }),
      DEFAULT_PATTERNS,
    )).toThrow(/non-negative integer/);
  });
});

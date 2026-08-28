import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertCommandResult,
  withGovernanceFixture,
} from './governance-test-helpers.mjs';


async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}


describe('governance test helpers', () => {
  it('creates the shared source fixture and removes it after the callback', async () => {
    let fixtureRoot;

    await withGovernanceFixture(async (fixture) => {
      fixtureRoot = fixture.rootDir;

      await expect(readFile(fixture.files.component, 'utf8')).resolves.toContain('FixtureComponent');
      await expect(readFile(fixture.files.dynamicModule, 'utf8')).resolves.toContain('fixtureDynamicValue');
      await expect(readFile(fixture.files.styles, 'utf8')).resolves.toContain('.fixture-card');

      expect(fixture.expected).toEqual({
        sourceFiles: 3,
        dynamicEdges: 1,
        selectorBlocks: 2,
        important: 1,
        media: 1,
        fallbackVariables: ['--fixture-safe'],
        undefinedVariables: ['--fixture-missing'],
      });
    });

    expect(await exists(fixtureRoot)).toBe(false);
  });

  it('reports command expectation failures with the command output', () => {
    expect(() => assertCommandResult(
      { exitCode: 1, stdout: 'health report', stderr: 'missing entry' },
      { exitCode: 0, stdoutIncludes: 'manifest', stderrIncludes: 'error' },
    )).toThrow(/expected exit code 0, received 1/);
  });
});

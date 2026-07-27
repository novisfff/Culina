import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('P0 API mock module boundary', () => {
  it('can be imported without side effects and exports its installer', () => {
    const fixtureUrl = pathToFileURL(
      resolve(process.cwd(), 'e2e/fixtures/apiMocks.mjs'),
    ).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module = await import(${JSON.stringify(fixtureUrl)});
         process.exit(typeof module.installApiMocks === 'function' ? 0 : 2);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.error, `${probe.stdout}\n${probe.stderr}`).toBeUndefined();
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
  });
});

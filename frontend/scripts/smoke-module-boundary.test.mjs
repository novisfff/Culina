import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('legacy smoke module boundary', () => {
  it('can be imported without starting the legacy suite and exports its API mock installer', () => {
    const smokeUrl = pathToFileURL(resolve(process.cwd(), 'scripts/smoke.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module = await import(${JSON.stringify(smokeUrl)});
         process.exit(typeof module.installApiMocks === 'function' ? 0 : 2);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.error, `${probe.stdout}\n${probe.stderr}`).toBeUndefined();
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
  });
});

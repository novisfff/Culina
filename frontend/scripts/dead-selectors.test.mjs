import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadStyleOwnership,
  scanSelectorUsage,
} from './dead-selectors.mjs';


async function createFixture(files) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'culina-dead-selectors-'));
  const paths = {};
  await Promise.all(Object.entries(files).map(async ([relativeFile, content]) => {
    const file = path.join(rootDir, relativeFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    paths[relativeFile] = file;
  }));
  return { rootDir, paths };
}


function ownershipEntry(selector, source = 'src/styles/domain.css') {
  return {
    selector,
    owner: 'domain',
    source,
    consumers: ['src/components/View.tsx'],
    sharedWith: [],
    dynamic: false,
    deleteWhen: 'No static or runtime consumer remains',
    test: 'scripts/dead-selectors.test.mjs',
  };
}


describe('dead selector report', () => {
  it('finds static usage across clsx, templates, SVG, CSS modules, and tests', async () => {
    const { rootDir, paths } = await createFixture({
      'src/styles/domain.css': `
        .card:hover { color: red; }
        .is-active .icon { color: green; }
        .template-prefix-item { display: block; }
        .module-card { padding: 1rem; }
        .e2e-visible { opacity: 1; }
        .unused-card { opacity: 0; }
      `,
      'src/components/View.tsx': `
        import clsx from 'clsx';
        import styles from './domain.module.css';
        export function View({ active, kind }) {
          return <svg className={clsx('card', { 'is-active': active })}>
            <path className="icon" />
            <g className={\`template-prefix-\${kind}\`} />
            <g className={styles.moduleCard} />
          </svg>;
        }
      `,
      'e2e/domain.spec.ts': `await expect(page.locator('.e2e-visible')).toBeVisible();`,
    });
    const ownership = new Map([
      '.card', '.is-active', '.icon', '.template-prefix-item', '.module-card', '.e2e-visible', '.unused-card',
    ].map((selector) => [selector, ownershipEntry(selector)]));

    const result = await scanSelectorUsage({
      rootDir,
      cssFiles: [paths['src/styles/domain.css']],
      tsxFiles: [paths['src/components/View.tsx']],
      e2eFiles: [paths['e2e/domain.spec.ts']],
      ownership,
    });

    expect(result.unused).toEqual([
      expect.objectContaining({
        selector: '.unused-card',
        file: 'src/styles/domain.css',
        line: 7,
      }),
    ]);
    expect(result.unused.map((entry) => entry.selector)).not.toEqual(expect.arrayContaining([
      '.card', '.is-active', '.icon', '.template-prefix-item', '.module-card', '.e2e-visible',
    ]));
  });

  it('keeps dynamic data attributes and unknown template selectors out of dead results', async () => {
    const { rootDir, paths } = await createFixture({
      'src/styles/domain.css': `
        [data-state="open"] .drawer { display: block; }
        .status-success { color: green; }
        .definitely-unused { color: gray; }
      `,
      'src/components/View.tsx': `
        export function View({ status }) {
          return <div data-state={status} className={\`status-\${status}\`} />;
        }
      `,
    });
    const ownership = new Map([
      ['.drawer', ownershipEntry('.drawer')],
      ['.status-success', { ...ownershipEntry('.status-success'), dynamic: true }],
      ['.definitely-unused', ownershipEntry('.definitely-unused')],
      ['[data-state="open"]', { ...ownershipEntry('[data-state="open"]'), dynamic: true }],
    ]);

    const result = await scanSelectorUsage({
      rootDir,
      cssFiles: [paths['src/styles/domain.css']],
      tsxFiles: [paths['src/components/View.tsx']],
      e2eFiles: [],
      ownership,
    });

    expect(result.dynamic.map((entry) => entry.selector)).toEqual(expect.arrayContaining([
      '[data-state="open"]',
      '.status-success',
    ]));
    expect(result.unused).toEqual([
      expect.objectContaining({ selector: '.definitely-unused' }),
    ]);
  });

  it('reports duplicate selectors separately from missing ownership', async () => {
    const { rootDir, paths } = await createFixture({
      'src/styles/a.css': '.shared-card { color: red; } .owned-card { color: blue; }',
      'src/styles/b.css': '.shared-card { color: green; }',
      'src/components/View.tsx': '<div className="shared-card owned-card" />',
    });
    const ownership = new Map([
      ['.owned-card', ownershipEntry('.owned-card', 'src/styles/a.css')],
    ]);

    const result = await scanSelectorUsage({
      rootDir,
      cssFiles: [paths['src/styles/a.css'], paths['src/styles/b.css']],
      tsxFiles: [paths['src/components/View.tsx']],
      e2eFiles: [],
      ownership,
    });

    expect(result.duplicate).toEqual([
      expect.objectContaining({ selector: '.shared-card', files: ['src/styles/a.css', 'src/styles/b.css'] }),
    ]);
    expect(result.ownerMissing).toEqual([
      expect.objectContaining({ selector: '.shared-card' }),
    ]);
  });

  it('loads ownership and rejects incomplete entries', async () => {
    const valid = ownershipEntry('.card');
    const { paths } = await createFixture({
      'style-ownership.json': `${JSON.stringify({ version: 1, selectors: [valid] })}\n`,
      'invalid.json': `${JSON.stringify({ version: 1, selectors: [{ selector: '.card' }] })}\n`,
    });

    await expect(loadStyleOwnership(paths['style-ownership.json'])).resolves.toEqual(
      new Map([['.card', valid]]),
    );
    await expect(loadStyleOwnership(paths['invalid.json'])).rejects.toThrow(/owner/);
  });
});

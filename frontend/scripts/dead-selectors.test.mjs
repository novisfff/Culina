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

  it('distinguishes base and responsive rules and propagates a compound rule owner', async () => {
    const { rootDir, paths } = await createFixture({
      'src/styles/domain.css': '.home-card { color: red; }',
      'src/styles/home-responsive.css': `
        @media (max-width: 767px) {
          .home-card { color: blue; }
          .app-shell:has(.home-card) { padding-bottom: 4rem; }
        }
      `,
      'src/components/View.tsx': '<div className="app-shell home-card" />',
    });
    const ownership = new Map();
    ownership.scopes = [{
      id: 'home',
      sources: ['src/styles/domain.css', 'src/styles/home-responsive.css'],
      prefixes: ['home-'],
    }];

    const result = await scanSelectorUsage({
      rootDir,
      cssFiles: [paths['src/styles/domain.css'], paths['src/styles/home-responsive.css']],
      tsxFiles: [paths['src/components/View.tsx']],
      e2eFiles: [],
      ownership,
    });

    expect(result.duplicate).toEqual([]);
    expect(result.ownerMissing).toEqual([]);
  });

  it('does not split commas inside functional pseudo selectors', async () => {
    const { rootDir, paths } = await createFixture({
      'src/styles/shared.css': '@media (max-width: 767px) { :is(.food-card, .home-card) { display: grid; } }',
      'src/styles/home.css': '@media (max-width: 767px) { .home-card { gap: 1rem; } }',
      'src/components/View.tsx': '<div className="food-card home-card" />',
    });

    const result = await scanSelectorUsage({
      rootDir,
      cssFiles: [paths['src/styles/shared.css'], paths['src/styles/home.css']],
      tsxFiles: [paths['src/components/View.tsx']],
      e2eFiles: [],
      ownership: new Map(),
    });

    expect(result.duplicate).toEqual([]);
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

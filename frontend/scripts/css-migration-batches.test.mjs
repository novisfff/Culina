import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCssMigrationBatches } from './css-migration-batches.mjs';


const EXPECTED_BATCH_IDS = [
  'shell-foundation',
  'home-family',
  'eat-meal',
  'ingredient-food-inventory',
  'ai-search',
  'compat-retire',
];
const EXPECTED_VIEWPORTS = ['375x812', '390x844', '430x932', '768x1024', '1024x768', '1440x900'];
const temporaryDirectories = [];


async function writeRegistry(value) {
  const directory = await mkdtemp(path.join(tmpdir(), 'culina-css-batches-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'batches.json');
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}


function validBatch(overrides = {}) {
  return {
    id: 'shell-foundation',
    status: 'active',
    sources: ['frontend/src/styles/07-mobile.css'],
    destinations: ['frontend/src/styles/shell.css'],
    owners: ['shell'],
    viewports: EXPECTED_VIEWPORTS,
    rollbackCommit: 'pending',
    ...overrides,
  };
}


afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});


describe('CSS migration batch registry', () => {
  it('loads the six ordered batches with one active batch and canonical viewports', async () => {
    const result = await readCssMigrationBatches(
      path.resolve(process.cwd(), 'scripts', 'css-migration-batches.json'),
    );

    expect(result.batches.map((batch) => batch.id)).toEqual(EXPECTED_BATCH_IDS);
    expect(result.batches.filter((batch) => batch.status === 'active').map((batch) => batch.id)).toEqual([
      'ingredient-food-inventory',
    ]);
    for (const batch of result.batches) {
      expect(batch.destinations.length).toBeGreaterThan(0);
      expect(batch.owners.length).toBeGreaterThan(0);
      expect(batch.viewports).toEqual(EXPECTED_VIEWPORTS);
      expect(batch).toHaveProperty('rollbackCommit');
      expect(batch.destinations).not.toContain('frontend/src/styles/07-mobile.css');
    }
  });

  it('rejects a source that overlaps between active batches', async () => {
    const file = await writeRegistry({
      version: 1,
      batches: [
        validBatch(),
        validBatch({ id: 'home-family', owners: ['home'] }),
      ],
    });

    await expect(readCssMigrationBatches(file)).rejects.toThrow(
      'home-family.sources: frontend/src/styles/07-mobile.css is already active in shell-foundation',
    );
  });

  it('rejects a registry that omits fixed batch ids', async () => {
    const file = await writeRegistry({ version: 1, batches: [validBatch()] });

    await expect(readCssMigrationBatches(file)).rejects.toThrow(
      `registry.batches: expected ordered ids ${EXPECTED_BATCH_IDS.join(',')}`,
    );
  });

  it('sorts missing owner, invalid viewport, rollback, and mobile destination errors', async () => {
    const file = await writeRegistry({
      version: 1,
      batches: [validBatch({
        owners: [],
        viewports: ['390x844'],
        destinations: ['frontend/src/styles/07-mobile.css'],
        rollbackCommit: '',
      })],
    });

    await expect(readCssMigrationBatches(file)).rejects.toThrow([
      'shell-foundation.destinations: 07-mobile.css cannot be a destination',
      'shell-foundation.owners: at least one owner is required',
      'shell-foundation.rollbackCommit: must be pending or a commit SHA',
      `shell-foundation.viewports: expected ${EXPECTED_VIEWPORTS.join(',')}`,
    ].join('\n'));
  });
});

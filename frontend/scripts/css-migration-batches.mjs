import { readFile } from 'node:fs/promises';


const EXPECTED_BATCH_IDS = [
  'shell-foundation',
  'home-family',
  'eat-meal',
  'ingredient-food-inventory',
  'ai-search',
  'compat-retire',
];
const EXPECTED_VIEWPORTS = ['375x812', '390x844', '430x932', '768x1024', '1024x768', '1440x900'];
const STATUS_VALUES = new Set(['planned', 'active', 'complete']);
const COMMIT_PATTERN = /^(?:pending|[a-f0-9]{8,40})$/i;


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}


export async function readCssMigrationBatches(filePath) {
  const registry = JSON.parse(await readFile(filePath, 'utf8'));
  const errors = [];
  if (registry?.version !== 1) errors.push('registry.version: must equal 1');
  if (!Array.isArray(registry?.batches)) {
    throw new Error('registry.batches: must be an array');
  }
  const ids = registry.batches.map((batch) => batch?.id);
  if (!sameArray(ids, EXPECTED_BATCH_IDS)) {
    errors.push(`registry.batches: expected ordered ids ${EXPECTED_BATCH_IDS.join(',')}`);
  }

  const activeSources = new Map();
  for (const batch of registry.batches) {
    const id = typeof batch?.id === 'string' && batch.id ? batch.id : '<missing-id>';
    if (!STATUS_VALUES.has(batch?.status)) errors.push(`${id}.status: must be planned, active, or complete`);
    if (!Array.isArray(batch?.sources) || batch.sources.length === 0) {
      errors.push(`${id}.sources: at least one source is required`);
    }
    if (!Array.isArray(batch?.destinations) || batch.destinations.length === 0) {
      errors.push(`${id}.destinations: at least one destination is required`);
    } else if (batch.destinations.includes('frontend/src/styles/07-mobile.css')) {
      errors.push(`${id}.destinations: 07-mobile.css cannot be a destination`);
    }
    if (!Array.isArray(batch?.owners) || batch.owners.length === 0) {
      errors.push(`${id}.owners: at least one owner is required`);
    }
    if (!sameArray(batch?.viewports, EXPECTED_VIEWPORTS)) {
      errors.push(`${id}.viewports: expected ${EXPECTED_VIEWPORTS.join(',')}`);
    }
    if (!COMMIT_PATTERN.test(batch?.rollbackCommit ?? '')) {
      errors.push(`${id}.rollbackCommit: must be pending or a commit SHA`);
    }
    if (batch?.status === 'active' && Array.isArray(batch.sources)) {
      for (const source of batch.sources) {
        const existing = activeSources.get(source);
        if (existing) errors.push(`${id}.sources: ${source} is already active in ${existing}`);
        else activeSources.set(source, id);
      }
    }
  }
  const active = registry.batches.filter((batch) => batch?.status === 'active');
  const allComplete = registry.batches.every((batch) => batch?.status === 'complete');
  if (active.length !== 1 && !(active.length === 0 && allComplete)) {
    errors.push(`registry.active: expected exactly one active batch unless all batches are complete, received ${active.length}`);
  }

  if (errors.length > 0) throw new Error(errors.sort(compareText).join('\n'));
  return registry;
}

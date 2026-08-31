import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function rollbackBundleEntry(state, entryId) {
  if (!state || state.version !== 1 || !state.entries || typeof state.entries !== 'object') {
    throw new Error('rollout state must contain version 1 and entries');
  }
  if (!state.entries[entryId]) throw new Error(`unknown rollout entry: ${entryId}`);
  return {
    ...state,
    entries: {
      ...state.entries,
      [entryId]: {
        ...state.entries[entryId],
        enabledMode: 'ratchet',
      },
    },
  };
}

function main(argv) {
  const statePath = argv.find((value) => value.startsWith('--state='))?.slice(8);
  const entryId = argv.find((value) => value.startsWith('--entry='))?.slice(8);
  const outputPath = argv.find((value) => value.startsWith('--output='))?.slice(9);
  if (!statePath || !entryId || !outputPath || !existsSync(statePath)) throw new Error('usage: --state=... --entry=... --output=...');
  const next = rollbackBundleEntry(JSON.parse(readFileSync(statePath, 'utf8')), entryId);
  writeFileSync(path.resolve(outputPath), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

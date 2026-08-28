const MODES = new Set(['ratchet', 'target']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertCommitList(value, label) {
  if (!Array.isArray(value) || value.length > 2 || value.some((item) => !isNonEmptyString(item))) {
    throw new Error(`${label} must contain at most two non-empty commit ids`);
  }
}

export function validateBudgetRolloutState(state, budgetConfig) {
  if (!state || state.version !== 1 || !state.entries || typeof state.entries !== 'object') {
    throw new Error('budget rollout state must contain version 1 and entries');
  }
  const budgetEntries = Object.keys(budgetConfig?.entries ?? {}).sort();
  const stateEntries = Object.keys(state.entries).sort();
  if (JSON.stringify(budgetEntries) !== JSON.stringify(stateEntries)) {
    throw new Error('budget rollout entries must exactly match bundle budget entries');
  }
  for (const [entry, value] of Object.entries(state.entries)) {
    if (!value || typeof value !== 'object' || !MODES.has(value.enabledMode)) {
      throw new Error(`budget rollout ${entry}.enabledMode must be ratchet or target`);
    }
    if (!isNonEmptyString(value.owner)) throw new Error(`budget rollout ${entry}.owner must be non-empty`);
    if (!Number.isInteger(value.phase) || value.phase < 0) throw new Error(`budget rollout ${entry}.phase must be non-negative`);
    const evidence = value.evidence;
    if (!evidence || typeof evidence !== 'object') throw new Error(`budget rollout ${entry}.evidence is required`);
    assertCommitList(evidence.buildCommits, `budget rollout ${entry}.evidence.buildCommits`);
    assertCommitList(evidence.viewportCommits, `budget rollout ${entry}.evidence.viewportCommits`);
    if (typeof evidence.manifestComplete !== 'boolean') throw new Error(`budget rollout ${entry}.evidence.manifestComplete must be boolean`);
    if (!Array.isArray(evidence.openExceptions) || evidence.openExceptions.some((item) => !isNonEmptyString(item))) {
      throw new Error(`budget rollout ${entry}.evidence.openExceptions must be a string array`);
    }
  }
  return state;
}

export function isTargetEligible(entryState) {
  const evidence = entryState?.evidence;
  return Boolean(
    entryState?.enabledMode === 'target'
    && evidence?.manifestComplete
    && evidence.buildCommits?.length === 2
    && evidence.viewportCommits?.length === 2
    && evidence.openExceptions?.length === 0,
  );
}

export function resolveEntryMode(entryState) {
  return isTargetEligible(entryState) ? 'target' : 'ratchet';
}

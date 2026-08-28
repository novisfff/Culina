import { describe, expect, it } from 'vitest';
import { isTargetEligible, resolveEntryMode, validateBudgetRolloutState } from './budget-rollout-state.mjs';

const budgetConfig = { entries: { home: {}, ai: {} } };
const baseState = {
  version: 1,
  entries: {
    home: { enabledMode: 'ratchet', owner: 'home', phase: 5, evidence: { buildCommits: [], viewportCommits: [], manifestComplete: false, openExceptions: [] } },
    ai: { enabledMode: 'ratchet', owner: 'ai', phase: 5, evidence: { buildCommits: [], viewportCommits: [], manifestComplete: false, openExceptions: [] } },
  },
};

describe('budget rollout state', () => {
  it('requires an exact entry set matching budgets', () => {
    expect(() => validateBudgetRolloutState({ ...baseState, entries: { home: baseState.entries.home } }, budgetConfig)).toThrow(/exactly match/);
  });

  it('keeps incomplete evidence on ratchet even when target is requested', () => {
    const entry = { ...baseState.entries.home, enabledMode: 'target' };
    expect(isTargetEligible(entry)).toBe(false);
    expect(resolveEntryMode(entry)).toBe('ratchet');
  });

  it('enables target only after two builds, two viewport runs, complete manifest, and no exceptions', () => {
    const entry = {
      enabledMode: 'target',
      owner: 'home',
      phase: 5,
      evidence: {
        buildCommits: ['a', 'b'],
        viewportCommits: ['a', 'b'],
        manifestComplete: true,
        openExceptions: [],
      },
    };
    expect(validateBudgetRolloutState({ version: 1, entries: { home: entry, ai: baseState.entries.ai } }, budgetConfig)).toBeTruthy();
    expect(isTargetEligible(entry)).toBe(true);
    expect(resolveEntryMode(entry)).toBe('target');
  });
});

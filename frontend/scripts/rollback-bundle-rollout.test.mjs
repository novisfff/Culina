import { describe, expect, it } from 'vitest';
import { rollbackBundleEntry } from './rollback-bundle-rollout.mjs';

const state = {
  version: 1,
  entries: {
    ai: { enabledMode: 'target', owner: 'ai', phase: 5, evidence: { buildCommits: ['a', 'b'], viewportCommits: ['c', 'd'], manifestComplete: true, openExceptions: [] } },
    home: { enabledMode: 'ratchet', owner: 'home', phase: 5, evidence: { buildCommits: [], viewportCommits: [], manifestComplete: false, openExceptions: [] } },
  },
};

describe('bundle rollout rollback', () => {
  it('rolls back only the selected entry to ratchet', () => {
    const next = rollbackBundleEntry(state, 'ai');
    expect(next.entries.ai.enabledMode).toBe('ratchet');
    expect(next.entries.home).toEqual(state.entries.home);
    expect(next.entries.ai.evidence).toEqual(state.entries.ai.evidence);
    expect(state.entries.ai.enabledMode).toBe('target');
  });

  it('rejects malformed state and unknown entries', () => {
    expect(() => rollbackBundleEntry(null, 'ai')).toThrow(/version/);
    expect(() => rollbackBundleEntry(state, 'missing')).toThrow(/unknown/);
  });

  it('does not accept a global rollback sentinel', () => {
    expect(() => rollbackBundleEntry(state, 'all')).toThrow(/unknown/);
  });
});

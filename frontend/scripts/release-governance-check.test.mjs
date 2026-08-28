import { describe, expect, it } from 'vitest';
import { checkReleaseEvidence, REQUIRED_VIEWPORTS } from './release-governance-check.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';

function completeEvidence() {
  return {
    manifest: { version: 1, sourceCommit: commit, entries: { main: {} }, manifestErrors: [] },
    budgetResult: { violations: [], manifestErrors: [] },
    viewportReport: {
      browserRun: true,
      viewports: Object.fromEntries(REQUIRED_VIEWPORTS.map((viewport) => [viewport, { status: 'passed' }])),
    },
    requestReport: { requestCount: 18, cacheReuse: true, longTaskMs: 0 },
    evidence: {
      buildCommit: commit,
      nodeVersion: 'v20.18.0',
      viteVersion: '5.4.21',
      rollbackCommand: 'git revert --no-edit 0123456',
    },
  };
}

describe('release governance evidence', () => {
  it('accepts complete browser and release evidence', () => {
    expect(checkReleaseEvidence(completeEvidence())).toEqual({ ok: true, missing: [], violations: [] });
  });

  it.each(REQUIRED_VIEWPORTS)('fails closed when %s evidence is missing', (viewport) => {
    const input = completeEvidence();
    delete input.viewportReport.viewports[viewport];
    expect(checkReleaseEvidence(input)).toMatchObject({ ok: false, missing: [`viewportReport.viewports.${viewport}`] });
  });

  it('does not accept build or unit-test evidence as a browser run', () => {
    const input = completeEvidence();
    input.viewportReport = { browserRun: false, testsPassed: true, buildPassed: true, viewports: input.viewportReport.viewports };
    expect(checkReleaseEvidence(input).missing).toContain('viewportReport.browserRun');
  });

  it('fails for missing request data and rollback command', () => {
    const input = completeEvidence();
    delete input.requestReport.requestCount;
    input.evidence.rollbackCommand = '';
    expect(checkReleaseEvidence(input)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(['requestReport.requestCount', 'evidence.rollbackCommand']),
    });
  });

  it('fails for manifest, budget, viewport, or commit violations', () => {
    const input = completeEvidence();
    input.manifest.manifestErrors.push({ type: 'orphan-chunk' });
    input.budgetResult.violations.push({ entry: 'main' });
    input.viewportReport.viewports['390x844'].status = 'failed';
    input.evidence.buildCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    expect(checkReleaseEvidence(input)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'manifest contains errors',
        'bundle budget contains violations',
        'viewport 390x844 did not pass',
        'build commit does not match manifest sourceCommit',
      ]),
    });
  });
});

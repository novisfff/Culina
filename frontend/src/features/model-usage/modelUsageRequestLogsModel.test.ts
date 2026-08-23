import { describe, expect, it } from 'vitest';
import {
  createModelUsageRequestLogFilters,
  toFamilyModelUsageRequestFilters,
  toPersonalModelUsageRequestFilters,
  transitionModelUsageRequestLogScope,
} from './modelUsageRequestLogsModel';

describe('modelUsageRequestLogsModel', () => {
  it('projects a family filter draft to the closed personal request contract', () => {
    const filters = createModelUsageRequestLogFilters('2026-08');
    const familyFilters = {
      ...filters,
      capability: 'llm' as const,
      provider: 'openai-compatible',
      model: 'gpt-family-secret',
      status: 'priced' as const,
      page: 2,
      limit: 20,
    };

    expect(toPersonalModelUsageRequestFilters(familyFilters)).toEqual({
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      capability: 'llm',
      status: 'priced',
      limit: 20,
      offset: 40,
    });
    expect(JSON.stringify(toPersonalModelUsageRequestFilters(familyFilters))).not.toMatch(/provider|model/i);
    expect(toFamilyModelUsageRequestFilters(familyFilters)).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-family-secret',
    });
  });

  it('clears owner-only filters before enabling personal request logs', () => {
    const next = transitionModelUsageRequestLogScope('me', {
      ...createModelUsageRequestLogFilters('2026-08'),
      provider: 'openai-compatible',
      model: 'gpt-family-secret',
      page: 3,
    });

    expect(next).toMatchObject({ scope: 'me', filters: { provider: '', model: '', page: 0 } });
  });
});

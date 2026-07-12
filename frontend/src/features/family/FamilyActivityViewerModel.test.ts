import { describe, expect, it } from 'vitest';
import type { ActivityLog, Member } from '../../api/types';
import {
  DEFAULT_FAMILY_ACTIVITY_FILTERS,
  buildFamilyActivityActorOptions,
  buildFamilyActivityQuery,
  familyActivityActionLabel,
  familyActivityEmptyDescription,
  familyActivityEntityLabel,
  groupFamilyActivitiesByDate,
  hasFamilyActivityFilters,
  resolveFamilyActivityViewerPhase,
} from './FamilyActivityViewerModel';

function activity(overrides: Partial<ActivityLog>): ActivityLog {
  return {
    id: 'activity-1',
    family_id: 'family-1',
    actor_id: 'user-1',
    actor_name: '林然',
    action: 'update',
    entity_type: 'Family',
    entity_id: 'family-1',
    summary: '更新家庭信息',
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  };
}

const members = [
  {
    id: 'user-1',
    username: 'lin',
    display_name: '林然',
    avatar_seed: 'lin',
    role: 'Owner',
    status: 'active',
  },
] as Member[];

describe('FamilyActivityViewerModel', () => {
  it('builds API query from preset and field filters', () => {
    expect(
      buildFamilyActivityQuery(
        {
          ...DEFAULT_FAMILY_ACTIVITY_FILTERS,
          datePreset: 'week',
          actorId: 'user-1',
          action: 'update',
          entityType: 'Family',
        },
        50,
        '2026-07-01'
      )
    ).toEqual({
      start_date: '2026-06-29',
      end_date: '2026-07-05',
      actor_id: 'user-1',
      action: 'update',
      entity_type: 'Family',
      limit: 50,
      offset: 0,
    });
  });

  it('uses custom dates when the custom preset is selected', () => {
    expect(
      buildFamilyActivityQuery(
        {
          ...DEFAULT_FAMILY_ACTIVITY_FILTERS,
          datePreset: 'custom',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
        100,
        '2026-07-01'
      )
    ).toMatchObject({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      limit: 100,
    });
  });

  it('derives actor options from members and activity fallback names', () => {
    const options = buildFamilyActivityActorOptions(
      [
        activity({ actor_id: 'user-1', actor_name: '旧名字' }),
        activity({ id: 'activity-2', actor_id: 'user-2', actor_name: 'AI 助手' }),
      ],
      members
    );

    expect(options).toContainEqual({ value: 'user-2', label: 'AI 助手' });
    expect(options).toContainEqual({ value: 'user-1', label: '林然' });
  });

  it('groups activities by local date and preserves item order', () => {
    const groups = groupFamilyActivitiesByDate([
      activity({ id: 'activity-new', created_at: '2026-07-01T10:00:00Z' }),
      activity({ id: 'activity-old', created_at: '2026-06-30T08:00:00Z' }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['2026-07-01', '2026-06-30']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['activity-new']);
  });

  it('maps known labels and detects active filters', () => {
    expect(familyActivityActionLabel('create')).toBe('新增');
    expect(familyActivityEntityLabel('ShoppingListItem')).toBe('购物清单');
    expect(familyActivityActionLabel('archive')).toBe('archive');
    expect(hasFamilyActivityFilters(DEFAULT_FAMILY_ACTIVITY_FILTERS)).toBe(false);
    expect(hasFamilyActivityFilters({ ...DEFAULT_FAMILY_ACTIVITY_FILTERS, actorId: 'user-1' })).toBe(true);
    expect(familyActivityEmptyDescription(true)).toContain('筛选条件');
  });

  it('resolves viewer phase without faking empty before cache exists', () => {
    expect(resolveFamilyActivityViewerPhase({
      queryData: undefined,
      seedData: undefined,
      logs: [],
      isQueryError: false,
      isPreviewError: false,
    })).toBe('loading');
    expect(resolveFamilyActivityViewerPhase({
      queryData: undefined,
      seedData: undefined,
      logs: [],
      isQueryError: true,
      isPreviewError: false,
    })).toBe('error');
    expect(resolveFamilyActivityViewerPhase({
      queryData: [],
      seedData: undefined,
      logs: [],
      isQueryError: false,
      isPreviewError: false,
    })).toBe('empty');
    expect(resolveFamilyActivityViewerPhase({
      queryData: [activity({})],
      seedData: undefined,
      logs: [activity({})],
      isQueryError: true,
      isPreviewError: false,
    })).toBe('ready');
  });
});

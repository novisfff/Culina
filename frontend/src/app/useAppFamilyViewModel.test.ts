import { describe, expect, it } from 'vitest';
import type { ActivityLog } from '../api/types';
import { buildAppFamilyViewModel } from './useAppFamilyViewModel';

const recentLog: ActivityLog = {
  id: 'activity-1',
  family_id: 'family-1',
  actor_id: 'user-1',
  actor_name: '小明',
  action: 'update',
  entity_type: 'Family',
  entity_id: 'family-1',
  summary: '更新家庭信息',
  created_at: '2026-07-12T10:00:00.000Z',
};

const oldLog: ActivityLog = {
  id: 'activity-2',
  family_id: 'family-1',
  actor_id: 'user-2',
  actor_name: '小红',
  action: 'create',
  entity_type: 'Ingredient',
  entity_id: 'ingredient-1',
  summary: '新增食材',
  created_at: '2026-06-01T10:00:00.000Z',
};

describe('buildAppFamilyViewModel', () => {
  it('does not convert a first Family load or failure into zero statistics', () => {
    expect(buildAppFamilyViewModel({
      data: undefined, isLoading: true, isError: false, isFetching: true, refetch: () => undefined,
    }).weekActivityValue).toBe('--');
    expect(buildAppFamilyViewModel({
      data: undefined, isLoading: false, isError: true, isFetching: false, refetch: () => undefined,
    }).activityPhase).toBe('error');
  });

  it('counts only the last 7 days once data is present', () => {
    const model = buildAppFamilyViewModel({
      data: [recentLog, oldLog],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => undefined,
      currentUserId: 'user-1',
      now: new Date('2026-07-12T12:00:00.000Z'),
    });
    expect(model.weekActivityValue).toBe(1);
    expect(model.currentUserRecentLogs).toBe(1);
    expect(model.activityPhase).toBe('ready');
    expect(model.hasRefreshError).toBe(false);
  });

  it('keeps stale counts when refresh fails after cache is present', () => {
    const model = buildAppFamilyViewModel({
      data: [recentLog],
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: () => undefined,
      currentUserId: 'user-1',
      now: new Date('2026-07-12T12:00:00.000Z'),
    });
    expect(model.weekActivityValue).toBe(1);
    expect(model.hasRefreshError).toBe(true);
    expect(model.activityPhase).toBe('ready');
  });

  it('marks empty only after a successful empty response', () => {
    const model = buildAppFamilyViewModel({
      data: [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => undefined,
    });
    expect(model.activityPhase).toBe('empty');
    expect(model.weekActivityValue).toBe(0);
    expect(model.currentUserRecentLogs).toBe(0);
  });
});

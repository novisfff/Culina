import type { ModelUsageAlert } from '../api/types/modelUsage';

export type BackgroundTaskNotification = {
  kind: 'background_task';
  notification_id: string;
  task_kind: 'image' | 'search_index';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  can_retry: boolean;
  can_dismiss: boolean;
  /** A stable backend code when one is available. Do not use display text as a branch condition. */
  error_code: string | null;
  title: string;
  description: string;
  occurred_at: string | null;
};

export type ModelUsageAlertNotification = {
  kind: 'model_usage_alert';
  notification_id: string;
  alert_id: string;
  severity: 'warning' | 'critical';
  period: string;
  seen: boolean;
  title: string;
  description: string;
  occurred_at: string;
};

export type AppNotificationItem =
  | BackgroundTaskNotification
  | ModelUsageAlertNotification;

export type AppNotificationGroupKey =
  | 'needs_attention'
  | 'in_progress'
  | 'recently_completed';

export type AppNotificationGroup = {
  key: AppNotificationGroupKey;
  label: string;
  items: AppNotificationItem[];
};

const SUCCESSFUL_HISTORY_LIMIT = 5;

const APP_NOTIFICATION_GROUPS: ReadonlyArray<Pick<AppNotificationGroup, 'key' | 'label'>> = [
  { key: 'needs_attention', label: '需要处理' },
  { key: 'in_progress', label: '进行中' },
  { key: 'recently_completed', label: '最近完成' },
];

function compareByRecency(left: AppNotificationItem, right: AppNotificationItem) {
  const timestampDiff = (right.occurred_at ?? '').localeCompare(left.occurred_at ?? '');
  if (timestampDiff !== 0) return timestampDiff;
  return right.notification_id.localeCompare(left.notification_id);
}

function groupKeyFor(item: AppNotificationItem): AppNotificationGroupKey {
  if (item.kind === 'model_usage_alert' || item.status === 'failed') {
    return 'needs_attention';
  }
  if (item.status === 'queued' || item.status === 'running') {
    return 'in_progress';
  }
  return 'recently_completed';
}

/**
 * The notification surface intentionally receives only safe alert copy. Owner-only
 * budget values remain in the model usage workspace and never flow into the global UI.
 */
export function modelUsageAlertNotification(alert: ModelUsageAlert): ModelUsageAlertNotification {
  const severity = alert.severity === 'critical' ? 'critical' : 'warning';
  return {
    kind: 'model_usage_alert',
    notification_id: alert.id,
    alert_id: alert.id,
    severity,
    period: alert.period,
    seen: alert.seen_at !== null,
    title: severity === 'critical' ? '模型用量需要处理' : '模型用量达到提醒线',
    description: '请查看模型用量，必要时调整预算或限额。',
    occurred_at: alert.created_at,
  };
}

export function groupAppNotifications(items: AppNotificationItem[]): AppNotificationGroup[] {
  const grouped = new Map<AppNotificationGroupKey, AppNotificationItem[]>(
    APP_NOTIFICATION_GROUPS.map(({ key }) => [key, []]),
  );
  items.forEach((item) => {
    grouped.get(groupKeyFor(item))?.push(item);
  });

  return APP_NOTIFICATION_GROUPS.flatMap(({ key, label }) => {
    const sortedItems = (grouped.get(key) ?? []).sort(compareByRecency);
    const itemsForGroup = key === 'recently_completed'
      ? sortedItems.slice(0, SUCCESSFUL_HISTORY_LIMIT)
      : sortedItems;
    return itemsForGroup.length > 0 ? [{ key, label, items: itemsForGroup }] : [];
  });
}

export function appNotificationStatusLabel(item: AppNotificationItem) {
  if (item.kind === 'model_usage_alert') {
    return item.severity === 'critical' ? '需要处理' : '提醒';
  }
  switch (item.status) {
    case 'queued':
    case 'running':
      return '处理中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
  }
}

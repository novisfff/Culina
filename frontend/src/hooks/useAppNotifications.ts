import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { ModelUsageAlert, ModelUsageAlertReceipt, UserRole } from '../api/types';
import {
  modelUsageAlertNotification,
  type AppNotificationItem,
  type ModelUsageAlertNotification,
} from '../app/appNotificationModel';
import type { BackgroundNotificationSource } from './useAiImageJobMonitor';

type UseAppNotificationsArgs = {
  enabled: boolean;
  familyId: string;
  role: UserRole;
  background: BackgroundNotificationSource;
  onOpenModelUsageAlert?: (alert: ModelUsageAlertNotification) => void;
};

function updateAlertReceipt(
  alerts: ModelUsageAlert[] | undefined,
  receipt: ModelUsageAlertReceipt,
) {
  return alerts?.map((alert) => alert.id === receipt.alert_id
    ? { ...alert, seen_at: receipt.seen_at, dismissed_at: receipt.dismissed_at }
    : alert);
}

export function useAppNotifications(args: UseAppNotificationsArgs) {
  const queryClient = useQueryClient();
  const previousFamilyIdRef = useRef(args.familyId || null);
  const ownerAlertsEnabled = args.enabled && args.role === 'Owner' && Boolean(args.familyId);
  const alertQueryKey = queryKeys.modelUsageAlerts(args.familyId);
  const alertsQuery = useQuery({
    queryKey: alertQueryKey,
    queryFn: api.getModelUsageAlerts,
    enabled: ownerAlertsEnabled,
    refetchInterval: ownerAlertsEnabled ? 60_000 : false,
    refetchOnWindowFocus: true,
  });

  // TanStack Query v5's browser default observes visibility changes only. The
  // global notice must also refresh when a tab regains window focus, including
  // browsers that do not emit a visibility transition for that interaction.
  useEffect(() => {
    if (!ownerAlertsEnabled || typeof window === 'undefined') return;
    const refetchOnWindowFocus = () => {
      void alertsQuery.refetch();
    };
    window.addEventListener('focus', refetchOnWindowFocus);
    return () => window.removeEventListener('focus', refetchOnWindowFocus);
  }, [alertsQuery.refetch, ownerAlertsEnabled]);

  useEffect(() => {
    const previousFamilyId = previousFamilyIdRef.current;
    if (previousFamilyId && previousFamilyId !== args.familyId) {
      void queryClient.cancelQueries({ queryKey: queryKeys.modelUsageAlerts(previousFamilyId) });
    }
    previousFamilyIdRef.current = args.familyId || null;
  }, [args.familyId, queryClient]);

  const seenMutation = useMutation({
    mutationFn: (variables: { alertId: string; familyId: string }) => api.markModelUsageAlertSeen(variables.alertId),
    onSuccess: (receipt, variables) => {
      queryClient.setQueryData<ModelUsageAlert[]>(
        queryKeys.modelUsageAlerts(variables.familyId),
        (current) => updateAlertReceipt(current, receipt),
      );
    },
  });
  const dismissMutation = useMutation({
    mutationFn: (variables: { alertId: string; familyId: string }) => api.dismissModelUsageAlert(variables.alertId),
    onSuccess: (receipt, variables) => {
      queryClient.setQueryData<ModelUsageAlert[]>(
        queryKeys.modelUsageAlerts(variables.familyId),
        (current) => updateAlertReceipt(current, receipt)?.filter((alert) => alert.dismissed_at === null),
      );
    },
  });

  const items = useMemo<AppNotificationItem[]>(() => [
    ...args.background.items,
    ...(ownerAlertsEnabled ? (alertsQuery.data ?? []).map(modelUsageAlertNotification) : []),
  ], [args.background.items, alertsQuery.data, ownerAlertsEnabled]);

  const openModelUsageAlert = useCallback((alert: ModelUsageAlertNotification) => {
    if (!ownerAlertsEnabled) return;
    if (!alert.seen) {
      void seenMutation.mutateAsync({ alertId: alert.alert_id, familyId: args.familyId }).catch(() => undefined);
    }
    args.onOpenModelUsageAlert?.(alert);
  }, [args.familyId, args.onOpenModelUsageAlert, ownerAlertsEnabled, seenMutation]);

  const dismissModelUsageAlert = useCallback((alertId: string) => {
    if (!ownerAlertsEnabled) return;
    void dismissMutation.mutateAsync({ alertId, familyId: args.familyId }).catch(() => undefined);
  }, [args.familyId, dismissMutation, ownerAlertsEnabled]);

  return {
    items,
    isLoading: args.background.isLoading || (ownerAlertsEnabled && alertsQuery.isLoading),
    openModelUsageAlert,
    dismissModelUsageAlert,
  };
}

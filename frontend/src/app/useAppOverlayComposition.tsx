import type { ReactNode } from 'react';
import { AppNotificationCenter } from './AppShell';
import { resolveAppOverlayState, type AppOverlayState } from './appOverlayState';
import type { NoticeState } from '../hooks/useNotice';
import type { useAppNotifications } from '../hooks/useAppNotifications';
import type { useAiImageJobMonitor } from '../hooks/useAiImageJobMonitor';

type Args = {
  notice: NoticeState | null;
  clearNotice: () => void;
  appNotifications: ReturnType<typeof useAppNotifications>;
  aiImageJobMonitor: ReturnType<typeof useAiImageJobMonitor>;
  globalSearchOpen: boolean;
  homeShoppingOpen: boolean;
  inventoryMaintenanceOpen: boolean;
  inventoryBusy: boolean;
};

export type AppOverlayComposition = {
  noticeToast: ReactNode;
  mobileNotificationCenter: ReactNode;
  appOverlayState: AppOverlayState;
};

/** Owns reusable notification/toast composition and overlay visibility derivation. */
export function useAppOverlayComposition(args: Args): AppOverlayComposition {
  const noticeToast = args.notice ? (
    <div className={`recipe-notice-toast tone-${args.notice.tone}`} role={args.notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="recipe-notice-icon" aria-hidden="true">
        {args.notice.tone === 'success' ? '✓' : '!'}
      </span>
      <span className="recipe-notice-copy">
        <strong>{args.notice.title}</strong>
        <small>{args.notice.message}</small>
      </span>
      <button type="button" onClick={args.clearNotice} aria-label="关闭提示">
        ×
      </button>
    </div>
  ) : null;

  const mobileNotificationCenter = (
    <AppNotificationCenter
      items={args.appNotifications.items}
      isLoading={args.appNotifications.isLoading}
      variant="mobileIcon"
      onDismissBackgroundTask={args.aiImageJobMonitor.dismissJob}
      onRetryBackgroundTask={args.aiImageJobMonitor.retryJob}
      retryingBackgroundTaskId={args.aiImageJobMonitor.retryingJobId}
      onOpenModelUsageAlert={args.appNotifications.openModelUsageAlert}
      onDismissModelUsageAlert={args.appNotifications.dismissModelUsageAlert}
    />
  );

  const appOverlayState = resolveAppOverlayState({
    globalSearchOpen: args.globalSearchOpen,
    homeShoppingOpen: args.homeShoppingOpen,
    inventoryMaintenanceOpen: args.inventoryMaintenanceOpen,
    inventoryBusy: args.inventoryBusy,
  });

  return { noticeToast, mobileNotificationCenter, appOverlayState };
}

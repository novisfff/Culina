import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../components/ui-kit';
import { DashboardIcon, ShellIcon, type ShellIconName } from './shellIcons';

export type TabKey = 'home' | 'foods' | 'recipes' | 'ingredients' | 'logs' | 'ai' | 'family';

const NAV_ITEMS: Array<{ key: TabKey; label: string; icon: ShellIconName }> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'foods', label: '食物', icon: 'foods' },
  { key: 'recipes', label: '菜谱', icon: 'recipes' },
  { key: 'ingredients', label: '食材', icon: 'ingredients' },
  { key: 'logs', label: '记录', icon: 'logs' },
  { key: 'ai', label: 'AI', icon: 'ai' },
  { key: 'family', label: '我的家庭', icon: 'family' },
];

const MOBILE_NAV_ITEMS: Array<{ key: TabKey; label: string; icon: ShellIconName }> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'foods', label: '食物', icon: 'foods' },
  { key: 'ai', label: 'AI', icon: 'ai' },
  { key: 'ingredients', label: '食材', icon: 'ingredients' },
  { key: 'family', label: '家庭', icon: 'family' },
];

const MOBILE_VIEWPORT_HEIGHT_VAR = '--app-visual-viewport-height';
const MOBILE_VIEWPORT_TOP_VAR = '--app-visual-viewport-top';
const MOBILE_VIEWPORT_BOTTOM_INSET_VAR = '--app-visual-viewport-bottom-inset';
const MOBILE_KEYBOARD_OPEN_CLASS = 'app-mobile-keyboard-open';

export type AppNotificationJob = {
  notification_id: string;
  task_id: string;
  kind: 'image' | 'search_index';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  title: string;
  status_label: string;
  description: string;
  can_retry: boolean;
  can_dismiss: boolean;
};

function notificationSummary(activeCount: number, failedCount: number, totalCount: number) {
  if (failedCount > 0) return `${failedCount} 条失败待处理`;
  if (activeCount > 0) return `${activeCount} 条任务正在处理`;
  if (totalCount > 0) return `${totalCount} 条最近通知`;
  return '暂无新通知';
}

function notificationSummaryTone(activeCount: number, failedCount: number) {
  if (failedCount > 0) return 'danger';
  if (activeCount > 0) return 'active';
  return 'quiet';
}

function viewportPixelValue(value: number) {
  return `${Math.max(0, Math.round(value))}px`;
}

function isTextEntryElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return element.matches('input, textarea, select');
}

function syncMobileVisualViewportMetrics() {
  const root = document.documentElement;
  const visualViewport = window.visualViewport ?? null;
  const layoutHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const visualHeight = visualViewport?.height ?? layoutHeight;
  const viewportOffsetTop = visualViewport?.offsetTop ?? 0;
  const coveredBottom = Math.max(0, layoutHeight - visualHeight - viewportOffsetTop);
  const isKeyboardOpen = coveredBottom > 80 && isTextEntryElement(document.activeElement);

  if (isKeyboardOpen) {
    root.style.setProperty(MOBILE_VIEWPORT_HEIGHT_VAR, viewportPixelValue(visualHeight));
    root.style.setProperty(MOBILE_VIEWPORT_TOP_VAR, viewportPixelValue(viewportOffsetTop));
    root.style.setProperty(MOBILE_VIEWPORT_BOTTOM_INSET_VAR, viewportPixelValue(coveredBottom));
  } else {
    root.style.removeProperty(MOBILE_VIEWPORT_HEIGHT_VAR);
    root.style.removeProperty(MOBILE_VIEWPORT_TOP_VAR);
    root.style.setProperty(MOBILE_VIEWPORT_BOTTOM_INSET_VAR, '0px');
  }
  root.classList.toggle(MOBILE_KEYBOARD_OPEN_CLASS, isKeyboardOpen);
}

function useMobileVisualViewportMetrics(activeTab: TabKey) {
  useEffect(() => {
    let frameId: number | null = null;
    const settleTimeoutIds: number[] = [];
    const visualViewport = window.visualViewport ?? null;

    const scheduleSync = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncMobileVisualViewportMetrics();
      });
    };

    const clearSettledSyncs = () => {
      while (settleTimeoutIds.length > 0) {
        const timeoutId = settleTimeoutIds.pop();
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
      }
    };

    const scheduleSettledSync = () => {
      clearSettledSyncs();
      scheduleSync();
      for (const delay of [80, 180, 360, 700]) {
        settleTimeoutIds.push(window.setTimeout(scheduleSync, delay));
      }
    };

    scheduleSync();
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('orientationchange', scheduleSettledSync);
    window.addEventListener('pageshow', scheduleSettledSync);
    document.addEventListener('visibilitychange', scheduleSettledSync);
    document.addEventListener('focusin', scheduleSettledSync);
    document.addEventListener('focusout', scheduleSettledSync);
    visualViewport?.addEventListener('resize', scheduleSync);
    visualViewport?.addEventListener('scroll', scheduleSync);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      clearSettledSyncs();
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('orientationchange', scheduleSettledSync);
      window.removeEventListener('pageshow', scheduleSettledSync);
      document.removeEventListener('visibilitychange', scheduleSettledSync);
      document.removeEventListener('focusin', scheduleSettledSync);
      document.removeEventListener('focusout', scheduleSettledSync);
      visualViewport?.removeEventListener('resize', scheduleSync);
      visualViewport?.removeEventListener('scroll', scheduleSync);
      document.documentElement.style.removeProperty(MOBILE_VIEWPORT_HEIGHT_VAR);
      document.documentElement.style.removeProperty(MOBILE_VIEWPORT_TOP_VAR);
      document.documentElement.style.removeProperty(MOBILE_VIEWPORT_BOTTOM_INSET_VAR);
      document.documentElement.classList.remove(MOBILE_KEYBOARD_OPEN_CLASS);
    };
  }, [activeTab]);
}

export function AppNotificationCenter(props: {
  jobs: AppNotificationJob[];
  isLoading?: boolean;
  variant?: 'desktop' | 'sidebar' | 'mobileIcon';
  onDismissJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
  retryingJobId?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const variant = props.variant ?? 'desktop';
  const activeCount = props.jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failedCount = props.jobs.filter((job) => job.status === 'failed').length;
  const hasJobs = props.jobs.length > 0;
  const totalCount = props.jobs.length;
  const summaryTone = notificationSummaryTone(activeCount, failedCount);

  useEffect(() => {
    if (!isOpen) return;

    function isInsideCenter(target: EventTarget | null) {
      return target instanceof Node && Boolean(centerRef.current?.contains(target) || popoverRef.current?.contains(target));
    }

    function handlePointerDown(event: PointerEvent) {
      if (!isInsideCenter(event.target)) {
        setIsOpen(false);
      }
    }

    function handleFocusIn(event: FocusEvent) {
      if (!isInsideCenter(event.target)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const popover = (
    <div
      ref={popoverRef}
      className={variant === 'mobileIcon' ? 'app-notification-popover mobile-notification-popover' : 'app-notification-popover'}
      role="dialog"
      aria-label="通知"
      aria-live="polite"
    >
      <div className="app-notification-popover-head">
        <span className="app-notification-head-copy">
          <span>通知</span>
          <strong>后台任务</strong>
        </span>
        <span className={`app-notification-summary tone-${summaryTone}`}>
          {notificationSummary(activeCount, failedCount, totalCount)}
        </span>
      </div>
      {props.isLoading ? (
        <p className="app-notification-empty">正在读取通知...</p>
      ) : hasJobs ? (
        <div className="app-notification-list">
          {props.jobs.map((job) => {
            const jobId = job.notification_id;
            const isRetrying = Boolean(jobId && props.retryingJobId === jobId);
            const canRetry = Boolean(jobId && job.can_retry && props.onRetryJob);
            return (
              <div key={jobId} className={`app-notification-row status-${job.status}`}>
                <span className="app-notification-row-icon" aria-hidden="true">
                  <DashboardIcon name={job.status === 'failed' ? 'bell' : job.status === 'succeeded' ? 'check' : 'circle'} />
                </span>
                <span className="app-notification-row-copy">
                  <span className="app-notification-row-title">
                    <strong title={job.title}>{job.title}</strong>
                    <em>{job.status_label}</em>
                  </span>
                  <small title={job.description}>{job.description}</small>
                </span>
                {jobId && job.can_dismiss && (
                  <span className="app-notification-row-actions">
                    {canRetry && (
                      <button
                        className="app-notification-retry"
                        type="button"
                        onClick={() => props.onRetryJob?.(jobId)}
                        disabled={isRetrying}
                        aria-label={`重试${job.title}`}
                        title={isRetrying ? '提交中' : '重试'}
                      >
                        <span aria-hidden="true">
                          <DashboardIcon name="refresh" />
                        </span>
                        {isRetrying ? '提交中' : '重试'}
                      </button>
                    )}
                    <button
                      className="app-notification-clear"
                      type="button"
                      onClick={() => props.onDismissJob?.(jobId)}
                      aria-label={`清除${job.title}通知`}
                      title="清除"
                    >
                      <DashboardIcon name="x" />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="app-notification-empty">当前没有通知。</p>
      )}
    </div>
  );

  return (
    <div
      ref={centerRef}
      className={
        variant === 'mobileIcon'
          ? 'app-notification-center mobile-notification-center'
          : variant === 'sidebar'
            ? 'app-notification-center sidebar-notification-center'
            : 'app-notification-center'
      }
    >
      <button
        className={activeCount > 0 || failedCount > 0 ? 'app-notification-trigger is-active' : 'app-notification-trigger'}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-label="查看通知"
      >
        <span className="app-notification-icon" aria-hidden="true">
          <DashboardIcon name="bell" />
          {totalCount > 0 && <span className="app-notification-count">{totalCount > 99 ? '99+' : totalCount}</span>}
        </span>
        {variant !== 'mobileIcon' && <strong>通知</strong>}
      </button>
      {isOpen && (variant === 'mobileIcon' ? createPortal(popover, document.body) : popover)}
    </div>
  );
}

type AppShellProps = {
  activeTab: TabKey;
  sidebarCollapsed: boolean;
  familyName: string;
  familyMotto: string;
  familyLocation: string;
  familyMemberLabel: string;
  familyActivityLabel: string;
  userName: string;
  userSeed: string;
  userImageUrl?: string;
  userMeta: string;
  userNote: string;
  notice?: ReactNode;
  imageJobs?: AppNotificationJob[];
  imageJobsLoading?: boolean;
  onDismissImageJob?: (jobId: string) => void;
  onRetryImageJob?: (jobId: string) => void;
  retryingImageJobId?: string | null;
  children: ReactNode;
  onTabChange: (tab: TabKey) => void;
  onToggleSidebar: () => void;
  onOpenProfile: () => void;
  onLogout: () => void;
};

export function AppShell({
  activeTab,
  sidebarCollapsed,
  familyName,
  familyMotto,
  familyLocation,
  familyMemberLabel,
  familyActivityLabel,
  userName,
  userSeed,
  userImageUrl,
  userMeta,
  userNote,
  notice,
  imageJobs = [],
  imageJobsLoading = false,
  onDismissImageJob,
  onRetryImageJob,
  retryingImageJobId,
  children,
  onTabChange,
  onToggleSidebar,
  onOpenProfile,
  onLogout,
}: AppShellProps) {
  const isAiActive = activeTab === 'ai';
  useMobileVisualViewportMetrics(activeTab);

  return (
    <div className={isAiActive ? 'app-shell app-shell-ai' : 'app-shell'}>
      {notice}
      <div className="page-glow page-glow-left" />
      <div className="page-glow page-glow-right" />
      <div className={sidebarCollapsed ? 'app-frame sidebar-collapsed' : 'app-frame sidebar-expanded'}>
        <aside className="sidebar-shell card">
          <div className="sidebar-top">
            <div className="sidebar-brand">
              <div className="sidebar-brand-row">
                <div className="sidebar-mark">
                  <ShellIcon name="logo" />
                </div>
                <div className="sidebar-brand-copy">
                  <strong>Culina</strong>
                  <span>家庭厨房工作台</span>
                </div>
                <div className="sidebar-brand-actions">
                  <AppNotificationCenter
                    jobs={imageJobs}
                    isLoading={imageJobsLoading}
                    variant="sidebar"
                    onDismissJob={onDismissImageJob}
                    onRetryJob={onRetryImageJob}
                    retryingJobId={retryingImageJobId}
                  />
                  <button
                    className="sidebar-toggle"
                    type="button"
                    onClick={onToggleSidebar}
                    aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                    title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                  >
                    <ShellIcon name={sidebarCollapsed ? 'panel-open' : 'panel-close'} />
                  </button>
                </div>
              </div>
              <div className="sidebar-family">
                <div className="sidebar-family-title">
                  <h2>{familyName}</h2>
                </div>
                <p className="subtle">{familyMotto}</p>
                <div className="sidebar-family-meta" aria-label="家庭信息">
                  <span>
                    <DashboardIcon name="map-pin" />
                    {familyLocation}
                  </span>
                  <span>
                    <DashboardIcon name="family" />
                    {familyMemberLabel}
                  </span>
                  <span className="sidebar-family-meta-active">
                    <DashboardIcon name="check" />
                    {familyActivityLabel}
                  </span>
                </div>
              </div>
            </div>

            <nav className="sidebar-nav" aria-label="大屏主导航">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  className={activeTab === item.key ? 'sidebar-nav-item active' : 'sidebar-nav-item'}
                  type="button"
                  onClick={() => onTabChange(item.key)}
                  aria-label={item.label}
                  title={item.label}
                >
                  <span className="sidebar-icon">
                    <ShellIcon name={item.icon} />
                  </span>
                  <span className="sidebar-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <div className="current-user-card sidebar-user-card">
              <button
                className="sidebar-user-settings"
                type="button"
                onClick={onOpenProfile}
                aria-label="编辑个人信息"
                title="编辑个人信息"
              >
                <DashboardIcon name="more" />
              </button>
              <div className="sidebar-user-main">
                <Avatar label={userName} seed={userSeed} imageUrl={userImageUrl} large={!sidebarCollapsed} />
                <div className="sidebar-user-copy">
                  <strong>{userName}</strong>
                  <p className="subtle">{userMeta}</p>
                  <p className="sidebar-user-note">{userNote}</p>
                </div>
              </div>
            </div>
            <button className="ghost-button sidebar-logout" type="button" onClick={onLogout} title="退出登录">
              <span className="sidebar-logout-icon">
                <ShellIcon name="logout" />
              </span>
              <span className="sidebar-logout-label">退出登录</span>
            </button>
          </div>
        </aside>

        <div className={isAiActive ? 'app-content app-content-ai' : 'app-content'}>
          <nav className="tabbar">
            <div className="tabbar-inner">
              <div className="tabbar-scroll">
                {NAV_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    className={activeTab === item.key ? 'tab-button active' : 'tab-button'}
                    type="button"
                    onClick={() => onTabChange(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </nav>
          {children}
        </div>
      </div>
      {activeTab !== 'ai' && activeTab !== 'logs' && (
        <nav className="mobile-bottom-nav" aria-label="手机主导航">
          {MOBILE_NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.key;
            const isAiTab = item.key === 'ai';
            return (
              <button
                key={item.key}
                className={`mobile-bottom-nav-item${isActive ? ' active' : ''}${isAiTab ? ' mobile-bottom-nav-ai-item' : ''}`}
                type="button"
                onClick={() => onTabChange(item.key)}
                aria-current={isActive ? 'page' : undefined}
              >
                {isAiTab ? (
                  <span className="mobile-bottom-nav-ai-avatar" aria-hidden="true">
                    <img src="/assets/ai-tab-chef-bot-active.webp" alt="" />
                  </span>
                ) : (
                  <span>
                    <ShellIcon name={item.icon} />
                  </span>
                )}
                <strong>{item.label}</strong>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../components/ui-kit';
import type { PrimaryTabKey } from './appNavigationModel';
import { DashboardIcon, ShellIcon, type ShellIconName } from './shellIcons';

/** @deprecated Prefer PrimaryTabKey; retained for legacy workspace consumers. */
export type TabKey = 'home' | 'foods' | 'recipes' | 'ingredients' | 'logs' | 'ai' | 'family';

export const PRIMARY_NAV_ITEMS: ReadonlyArray<{
  key: PrimaryTabKey;
  label: string;
  icon: ShellIconName;
}> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'eat', label: '吃什么', icon: 'foods' },
  { key: 'ingredients', label: '食材', icon: 'ingredients' },
  { key: 'ai', label: 'AI', icon: 'ai' },
  { key: 'family', label: '家庭', icon: 'family' },
];

// Desktop keeps the information-oriented sidebar order. On phones, AI is the
// center primary action so the raised avatar aligns with the middle grid slot.
const MOBILE_PRIMARY_NAV_ITEMS = [
  PRIMARY_NAV_ITEMS[0]!,
  PRIMARY_NAV_ITEMS[1]!,
  PRIMARY_NAV_ITEMS[3]!,
  PRIMARY_NAV_ITEMS[2]!,
  PRIMARY_NAV_ITEMS[4]!,
] as const;

const MOBILE_VIEWPORT_HEIGHT_VAR = '--app-visual-viewport-height';
const MOBILE_VIEWPORT_TOP_VAR = '--app-visual-viewport-top';
const MOBILE_VIEWPORT_BOTTOM_INSET_VAR = '--app-visual-viewport-bottom-inset';
const MOBILE_VIEWPORT_LAYOUT_HEIGHT_VAR = '--app-visual-viewport-layout-height';
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
  created_at?: string | null;
  completed_at?: string | null;
};

const SUCCESSFUL_HISTORY_LIMIT = 5;

function jobSortTimestamp(job: AppNotificationJob) {
  return job.completed_at ?? job.created_at ?? '';
}

function compareJobsByRecency(left: AppNotificationJob, right: AppNotificationJob) {
  const timestampDiff = jobSortTimestamp(right).localeCompare(jobSortTimestamp(left));
  if (timestampDiff !== 0) return timestampDiff;
  return right.notification_id.localeCompare(left.notification_id);
}

export function orderBackgroundTaskJobs(jobs: AppNotificationJob[]) {
  const failed = jobs.filter((job) => job.status === 'failed').sort(compareJobsByRecency);
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running').sort(compareJobsByRecency);
  const succeeded = jobs
    .filter((job) => job.status === 'succeeded')
    .sort(compareJobsByRecency)
    .slice(0, SUCCESSFUL_HISTORY_LIMIT);
  return [...failed, ...active, ...succeeded];
}

function notificationSummary(activeCount: number, failedCount: number, totalCount: number) {
  if (failedCount > 0) return `${failedCount} 条失败待处理`;
  if (activeCount > 0) return `${activeCount} 条任务正在处理`;
  if (totalCount > 0) return `${totalCount} 条最近任务`;
  return '暂无后台任务';
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
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const viewportOffsetTop = visualViewport?.offsetTop ?? 0;
  const coveredBottom = Math.max(0, window.innerHeight - viewportHeight - viewportOffsetTop);
  const isKeyboardOpen = coveredBottom > 80 && isTextEntryElement(document.activeElement);
  const keyboardInset = isKeyboardOpen ? coveredBottom : 0;

  root.style.setProperty(MOBILE_VIEWPORT_HEIGHT_VAR, viewportPixelValue(viewportHeight));
  root.style.setProperty(MOBILE_VIEWPORT_TOP_VAR, viewportPixelValue(viewportOffsetTop));
  root.style.setProperty(MOBILE_VIEWPORT_BOTTOM_INSET_VAR, viewportPixelValue(keyboardInset));
  root.style.setProperty(MOBILE_VIEWPORT_LAYOUT_HEIGHT_VAR, viewportPixelValue(viewportHeight + keyboardInset));
  root.classList.toggle(MOBILE_KEYBOARD_OPEN_CLASS, isKeyboardOpen);
}

function useMobileVisualViewportMetrics(activeTab: PrimaryTabKey) {
  useEffect(() => {
    let frameId: number | null = null;
    const timeoutIds: number[] = [];
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

    const scheduleKeyboardTransitionSync = () => {
      scheduleSync();
      timeoutIds.push(window.setTimeout(scheduleSync, 80));
      timeoutIds.push(window.setTimeout(scheduleSync, 260));
    };

    scheduleSync();
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('orientationchange', scheduleSync);
    window.addEventListener('pageshow', scheduleSync);
    document.addEventListener('visibilitychange', scheduleSync);
    document.addEventListener('focusin', scheduleKeyboardTransitionSync);
    document.addEventListener('focusout', scheduleKeyboardTransitionSync);
    visualViewport?.addEventListener('resize', scheduleSync);
    visualViewport?.addEventListener('scroll', scheduleSync);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('orientationchange', scheduleSync);
      window.removeEventListener('pageshow', scheduleSync);
      document.removeEventListener('visibilitychange', scheduleSync);
      document.removeEventListener('focusin', scheduleKeyboardTransitionSync);
      document.removeEventListener('focusout', scheduleKeyboardTransitionSync);
      visualViewport?.removeEventListener('resize', scheduleSync);
      visualViewport?.removeEventListener('scroll', scheduleSync);
      document.documentElement.classList.remove(MOBILE_KEYBOARD_OPEN_CLASS);
    };
  }, [activeTab]);
}

function OrientationLockScreen(props: { mode: 'landscape' | 'portrait' }) {
  const isLandscapeMode = props.mode === 'landscape';

  return (
    <section
      className={`app-orientation-lock app-orientation-lock-${props.mode}`}
      aria-live="polite"
      aria-label={isLandscapeMode ? '请横屏使用 Culina' : '请竖屏使用 Culina'}
    >
      <div className="app-orientation-card" role="status">
        <span className="app-orientation-logo" aria-hidden="true">
          <ShellIcon name="logo" />
        </span>
        <div className="app-orientation-copy">
          <p>{isLandscapeMode ? '请横屏使用 Culina' : '请竖屏使用 Culina'}</p>
          <strong>{isLandscapeMode ? '电脑和 iPad 端需要横屏查看' : '手机端需要竖屏查看'}</strong>
          <span>{isLandscapeMode ? '旋转设备后，家庭厨房工作台会自动恢复。' : '旋转手机后，就能继续记录和查看。'}</span>
        </div>
      </div>
    </section>
  );
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
  const visibleJobs = orderBackgroundTaskJobs(props.jobs);
  const activeCount = visibleJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failedCount = visibleJobs.filter((job) => job.status === 'failed').length;
  const attentionCount = activeCount + failedCount;
  const hasJobs = visibleJobs.length > 0;
  const totalCount = visibleJobs.length;
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
      aria-label="后台任务"
      aria-live="polite"
    >
      <div className="app-notification-popover-head">
        <span className="app-notification-head-copy">
          <span>进度</span>
          <strong>后台任务</strong>
        </span>
        <span className={`app-notification-summary tone-${summaryTone}`}>
          {notificationSummary(activeCount, failedCount, totalCount)}
        </span>
      </div>
      {props.isLoading ? (
        <p className="app-notification-empty">正在读取后台任务...</p>
      ) : hasJobs ? (
        <div className="app-notification-list">
          {visibleJobs.map((job) => {
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
        <p className="app-notification-empty">当前没有后台任务。</p>
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
        aria-label={(() => {
          if (attentionCount <= 0) {
            return '查看后台任务';
          }
          const parts: string[] = [];
          if (failedCount > 0) {
            parts.push(`${failedCount} 个失败`);
          }
          if (activeCount > 0) {
            parts.push(`${activeCount} 个进行中`);
          }
          return `查看后台任务，${parts.join('，')}`;
        })()}
      >
        <span className="app-notification-icon" aria-hidden="true">
          <DashboardIcon name="bell" />
          {attentionCount > 0 && (
            <span className="app-notification-count">{attentionCount > 99 ? '99+' : attentionCount}</span>
          )}
        </span>
        {variant !== 'mobileIcon' && <strong>后台任务</strong>}
      </button>
      {isOpen && (variant === 'mobileIcon' ? createPortal(popover, document.body) : popover)}
    </div>
  );
}

type AppShellProps = {
  activeTab: PrimaryTabKey;
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
  onTabChange: (tab: PrimaryTabKey) => void;
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
      <OrientationLockScreen mode="landscape" />
      <OrientationLockScreen mode="portrait" />
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
              {PRIMARY_NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  className={activeTab === item.key ? 'sidebar-nav-item active' : 'sidebar-nav-item'}
                  type="button"
                  onClick={() => onTabChange(item.key)}
                  aria-label={item.label}
                  aria-current={activeTab === item.key ? 'page' : undefined}
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
          <nav className="tabbar" aria-label="顶部主导航">
            <div className="tabbar-inner">
              <div className="tabbar-scroll">
                {PRIMARY_NAV_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    className={activeTab === item.key ? 'tab-button active' : 'tab-button'}
                    type="button"
                    onClick={() => onTabChange(item.key)}
                    aria-current={activeTab === item.key ? 'page' : undefined}
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
      {activeTab !== 'ai' && (
        <nav className="mobile-bottom-nav" aria-label="手机主导航">
          {MOBILE_PRIMARY_NAV_ITEMS.map((item) => {
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

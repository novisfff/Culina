import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiRenderResponse } from '../api/types';
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

const IMAGE_JOB_TARGET_LABELS: Record<string, string> = {
  food: '食物',
  ingredient: '食材',
  recipe: '菜谱',
  food_scene: '食物场景',
  meal_log: '餐食记录',
  user: '头像',
  family: '家庭图',
};

function imageJobTargetLabel(job: AiRenderResponse) {
  return job.target_entity_type ? IMAGE_JOB_TARGET_LABELS[job.target_entity_type] ?? '图片' : 'AI';
}

function imageJobTitle(job: AiRenderResponse) {
  const targetLabel = imageJobTargetLabel(job);
  const targetName = job.target_entity_name?.trim();
  return targetName ? `${targetName}的${targetLabel}图片生成` : `${targetLabel}图片生成`;
}

function imageJobStatusLabel(job: AiRenderResponse) {
  if (job.status === 'queued' || job.status === 'running') return '正在处理';
  if (job.status === 'failed') return '失败';
  if (job.bind_status === 'skipped') return '已生成，未替换';
  if (job.bind_status === 'bound') return '已更新';
  return '已生成';
}

function imageJobStatusDescription(job: AiRenderResponse) {
  if (job.status === 'queued') return '已加入队列，稍后开始生成';
  if (job.status === 'running') return '正在生成图片，可以先处理其他内容';
  if (job.status === 'failed') return job.error?.trim() || '生成失败，可以直接重试';
  if (job.bind_status === 'skipped') return '已有用户图片，生成图已保留';
  if (job.bind_status === 'bound') return '主图已自动更新';
  return '生成图已保留在图片资产中';
}

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

export function AppNotificationCenter(props: {
  jobs: AiRenderResponse[];
  isLoading?: boolean;
  variant?: 'desktop' | 'sidebar' | 'mobileIcon';
  onDismissJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
  retryingJobId?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const variant = props.variant ?? 'desktop';
  const activeCount = props.jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failedCount = props.jobs.filter((job) => job.status === 'failed').length;
  const hasJobs = props.jobs.length > 0;
  const totalCount = props.jobs.length;
  const summaryTone = notificationSummaryTone(activeCount, failedCount);

  useEffect(() => {
    if (!isOpen) return;

    function isInsideCenter(target: EventTarget | null) {
      return target instanceof Node && Boolean(centerRef.current?.contains(target));
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
      {isOpen && (
        <div className="app-notification-popover" role="dialog" aria-label="通知" aria-live="polite">
          <div className="app-notification-popover-head">
            <span className="app-notification-head-copy">
              <span>通知</span>
              <strong>图片生成任务</strong>
            </span>
            <span className={`app-notification-summary tone-${summaryTone}`}>
              {notificationSummary(activeCount, failedCount, totalCount)}
            </span>
          </div>
          {props.isLoading ? (
            <p className="app-notification-empty">正在读取通知...</p>
          ) : hasJobs ? (
            <div className="app-notification-list">
              {props.jobs.slice(0, 6).map((job) => {
                const jobId = job.job_id ?? null;
                const isRetrying = Boolean(jobId && props.retryingJobId === jobId);
                const canRetry = Boolean(jobId && job.status === 'failed' && props.onRetryJob);
                return (
                  <div key={jobId ?? `${job.target_entity_type}-${job.target_entity_id}`} className={`app-notification-row status-${job.status}`}>
                    <span className="app-notification-row-icon" aria-hidden="true">
                      <DashboardIcon name={job.status === 'failed' ? 'bell' : job.status === 'succeeded' ? 'check' : 'circle'} />
                    </span>
                    <span className="app-notification-row-copy">
                      <span className="app-notification-row-title">
                        <strong title={imageJobTitle(job)}>{imageJobTitle(job)}</strong>
                        <em>{imageJobStatusLabel(job)}</em>
                      </span>
                      <small title={imageJobStatusDescription(job)}>{imageJobStatusDescription(job)}</small>
                    </span>
                    {jobId && (job.status === 'succeeded' || job.status === 'failed') && (
                      <span className="app-notification-row-actions">
                        {canRetry && (
                          <button
                            className="app-notification-retry"
                            type="button"
                            onClick={() => props.onRetryJob?.(jobId)}
                            disabled={isRetrying}
                            aria-label={`重试${imageJobTitle(job)}`}
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
                          aria-label={`清除${imageJobTitle(job)}通知`}
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
      )}
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
  imageJobs?: AiRenderResponse[];
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

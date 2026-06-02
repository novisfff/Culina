import type { ReactNode } from 'react';
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
  children,
  onTabChange,
  onToggleSidebar,
  onOpenProfile,
  onLogout,
}: AppShellProps) {
  return (
    <div className="app-shell">
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

        <div className="app-content">
          <nav className="tabbar">
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

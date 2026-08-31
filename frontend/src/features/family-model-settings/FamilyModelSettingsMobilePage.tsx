import type { ReactNode } from 'react';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ModelPriceEditor } from './ModelPriceEditor';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { ConfigurationCheck } from './ConfigurationCheck';
import { SearchProfilePanel } from './SearchProfilePanel';
import type { FamilyModelSettingsSection } from './useFamilyModelSettingsState';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';

const MOBILE_TASKS: ReadonlyArray<{
  id: Exclude<FamilyModelSettingsSection, 'overview'>;
  label: string;
  description: string;
}> = [
  { id: 'providers', label: '模型服务', description: '管理连接方式、服务范围与密钥。' },
  { id: 'capabilities', label: '功能设置', description: '选择需要启用的七类 AI 功能。' },
  { id: 'prices', label: '模型价格', description: '可选设置；未填写的价格按 0 元计入费用。' },
  { id: 'search', label: '智能搜索', description: '查看或安全地更换家庭搜索设置。' },
  { id: 'review', label: '配置检查', description: '查看服务、功能和价格是否完整。' },
];

function getMobileTaskIcon(id: string): ReactNode {
  switch (id) {
    case 'providers':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="6" rx="2" />
          <rect x="3" y="14" width="18" height="6" rx="2" />
          <circle cx="7" cy="7" r="1" fill="currentColor" />
          <circle cx="7" cy="17" r="1" fill="currentColor" />
          <path d="M11 7h6M11 17h6" />
        </svg>
      );
    case 'capabilities':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2Z" />
          <path d="M18.5 15.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" />
        </svg>
      );
    case 'prices':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
          <circle cx="7" cy="7" r="1.5" fill="currentColor" />
        </svg>
      );
    case 'search':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7.5" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
      );
    case 'review':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    default:
      return null;
  }
}

function taskTitle(section: FamilyModelSettingsSection): string {
  if (section === 'overview') return '家庭 AI 服务';
  return MOBILE_TASKS.find((task) => task.id === section)?.label ?? '家庭 AI 服务';
}

function MobileOverview(props: FamilyModelSettingsSurfaceProps) {
  return (
    <>
      <section className="family-model-settings-mobile-summary" aria-labelledby="family-model-settings-mobile-summary-title">
        <div className="family-model-settings-mobile-summary-top">
          <span className={`family-model-settings-configuration-status is-${props.overview.configurationStatus.kind}`}>
            <span className="family-model-settings-status-dot" aria-hidden="true" />
            {props.overview.configurationStatus.label}
          </span>
        </div>
        <h1 id="family-model-settings-mobile-summary-title">{props.overview.title}</h1>
        <p className="family-model-settings-mobile-summary-desc">{props.overview.configurationStatus.description}</p>
        <div className="family-model-settings-mobile-metrics">
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.providerCount}</strong>
            <span>模型服务</span>
          </div>
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.enabledCapabilityCount}</strong>
            <span>已选功能</span>
          </div>
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.pricedCapabilityCount}/{props.overview.enabledCapabilityCount}</strong>
            <span>已填价格</span>
          </div>
        </div>
        <p className="family-model-settings-overview-summary visually-hidden">
          {props.overview.providerCount} 个服务 · {props.overview.enabledCapabilityCount} 类功能 · {props.overview.pricedCapabilityCount}/{props.overview.enabledCapabilityCount} 类已填写价格
        </p>
      </section>
      <nav className="family-model-settings-mobile-task-list" aria-label="家庭 AI 服务任务">
        {MOBILE_TASKS.map((task) => {
          const isComplete = props.overview.steps.find((step) => step.id === task.id)?.status === 'complete';
          const isNext = props.overview.primarySection === task.id;
          const optional = task.id === 'prices' || task.id === 'search' || task.id === 'review';
          const statusKind = optional
            ? 'optional'
            : isComplete
              ? 'complete'
              : isNext
                ? 'next'
                : 'pending';
          const statusLabel = optional
            ? '可选'
            : isComplete
              ? '已完成'
              : isNext
                ? '下一步'
                : '未完成';

          return (
            <button
              key={task.id}
              type="button"
              aria-label={task.label}
              className={`family-model-settings-mobile-task-item is-${statusKind}`}
              disabled={props.busyAction !== null}
              onClick={() => props.onPushMobileTask(task.id)}
            >
              <span className={`family-model-settings-mobile-task-icon tone-${task.id}`} aria-hidden="true">
                {getMobileTaskIcon(task.id)}
              </span>
              <span className="family-model-settings-mobile-task-copy">
                <strong>{task.label}</strong>
                <small>{task.description}</small>
              </span>
              <span className="family-model-settings-mobile-task-end">
                <span className={`family-model-settings-mobile-task-state state-${statusKind}`}>
                  {statusLabel}
                </span>
                <svg className="family-model-settings-mobile-task-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

function MobileTaskBody(props: FamilyModelSettingsSurfaceProps) {
  switch (props.state.section) {
    case 'providers':
      return (
        <ProviderProfileEditor
          profiles={props.settings.provider_profiles}
          settingsVersionNumber={props.settings.version_number}
          selectedProfileId={props.state.selectedProfileId}
          busy={props.busyAction !== null}
          onSelectProfile={props.onSelectProfile}
          onRebindCreatedProfile={props.onRebindCreatedProfile}
          onCreate={(input) => props.actions.createProviderProfile({ ...input, idempotency_key: '' })}
          onPatch={(profileId, input) => props.actions.patchProviderProfile(profileId, { ...input, idempotency_key: '' })}
          onRotate={props.actions.rotateProviderProfileKey}
          onCheck={(profileId) => props.actions.checkProviderConnection(profileId)}
        />
      );
    case 'capabilities':
      return (
        <CapabilityBindingEditor
          draft={props.draft}
          profiles={props.settings.provider_profiles}
          busy={props.busyAction !== null}
          onDraftChange={props.onDraftChange}
          onDiscoverModels={props.onDiscoverModels}
          onTestCapability={props.onTestCapability}
        />
      );
    case 'prices':
      return <ModelPriceEditor draft={props.draft} busy={props.busyAction !== null} onDraftChange={props.onDraftChange} />;
    case 'search':
      return <SearchProfilePanel {...props} />;
    case 'review':
      return <ConfigurationCheck {...props} />;
    case 'overview':
      return <MobileOverview {...props} />;
    default: {
      const exhaustive: never = props.state.section;
      return exhaustive;
    }
  }
}

function MobileFooter(props: FamilyModelSettingsSurfaceProps) {
  const busy = props.busyAction !== null;
  if (props.state.section !== 'overview') return null;

  return (
    <footer className="family-model-settings-mobile-footer">
      {props.errorMessage ? <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p> : null}
      <div>
        <button className="solid-button family-model-settings-mobile-primary-cta" type="button" disabled={busy} onClick={() => props.onPushMobileTask(props.overview.primarySection)}>
          <span>{props.overview.primaryLabel}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </footer>
  );
}

/** A phone-first task shell; it intentionally does not reuse desktop layout JSX. */
export function FamilyModelSettingsMobilePage(props: FamilyModelSettingsSurfaceProps) {
  const busy = props.busyAction !== null;
  const isOverview = props.state.section === 'overview';

  return (
    <main className="family-model-settings-mobile-page" aria-label="家庭 AI 服务" aria-busy={busy || undefined}>
      <header className="family-model-settings-mobile-header">
        <button
          className="family-model-settings-mobile-back"
          type="button"
          aria-label={isOverview ? '返回家庭' : '返回服务概览'}
          disabled={busy}
          onClick={isOverview ? props.onBack : props.onPopMobileTask}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span>{isOverview ? '返回家庭' : '返回概览'}</span>
        </button>
        <strong>{taskTitle(props.state.section)}</strong>
        <span className="family-model-settings-mobile-header-spacer" aria-hidden="true" />
      </header>
      <div className="family-model-settings-mobile-scroll">
        {props.stale ? <p className="family-model-settings-stale" role="status">刷新失败，正在显示上次成功的非敏感数据。</p> : null}
        {props.errorMessage ? (
          <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p>
        ) : props.state.section !== 'overview' ? (
          <p className={`family-model-settings-auto-save-status ${props.serverDraft.validation_status === 'invalid' ? 'is-warning' : 'is-ready'}`} role="status">
            <span className="family-model-settings-status-dot" aria-hidden="true" />
            {props.busyAction === 'save'
              ? '正在自动保存…'
              : props.state.dirty
                ? '修改将在稍后自动保存'
                : props.serverDraft.validation_status === 'invalid'
                  ? '已保存，配置仍可继续完善'
                  : '修改会自动保存并生效'}
          </p>
        ) : null}
        <MobileTaskBody {...props} />
      </div>
      <MobileFooter {...props} />
    </main>
  );
}

import type { ReactNode } from 'react';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ModelPriceEditor } from './ModelPriceEditor';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { PublishReview } from './PublishReview';
import { SearchProfilePanel } from './SearchProfilePanel';
import type { FamilyModelSettingsSection } from './useFamilyModelSettingsState';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';

const MOBILE_TASKS: ReadonlyArray<{
  id: Exclude<FamilyModelSettingsSection, 'overview'>;
  label: string;
  description: string;
}> = [
  { id: 'providers', label: 'Provider 服务', description: '管理连接方式、服务范围与凭据。' },
  { id: 'capabilities', label: '能力配置', description: '选择需要启用的七类模型能力。' },
  { id: 'prices', label: '模型价格', description: '补齐启用能力的全部计价规则。' },
  { id: 'search', label: '搜索索引', description: '查看或安全地替换家庭搜索索引。' },
  { id: 'review', label: '发布复核', description: '检查能力、价格和搜索影响后发布。' },
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
          <span className={`family-model-settings-publication is-${props.overview.publication.kind}`}>
            <span className="family-model-settings-status-dot" aria-hidden="true" />
            {props.overview.publication.label}
          </span>
        </div>
        <h1 id="family-model-settings-mobile-summary-title">家庭 AI 服务</h1>
        <p className="family-model-settings-mobile-summary-desc">{props.overview.publication.description}</p>
        <div className="family-model-settings-mobile-stats-row">
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.providerCount}</strong>
            <span>服务档案</span>
          </div>
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.enabledCapabilityCount}</strong>
            <span>已选能力</span>
          </div>
          <div className="family-model-settings-mobile-stat">
            <strong>{props.overview.pricedCapabilityCount}/{props.overview.enabledCapabilityCount}</strong>
            <span>价格就绪</span>
          </div>
        </div>
        <p className="family-model-settings-overview-summary visually-hidden">
          {props.overview.providerCount} 个服务 · {props.overview.enabledCapabilityCount} 类能力 · {props.overview.pricedCapabilityCount}/{props.overview.enabledCapabilityCount} 类价格就绪
        </p>
      </section>
      <nav className="family-model-settings-mobile-task-list" aria-label="家庭 AI 服务任务">
        {MOBILE_TASKS.map((task) => {
          const isComplete = props.overview.steps.find((step) => step.id === task.id)?.status === 'complete';
          const isNext = props.overview.primarySection === task.id;
          const statusKind = task.id === 'search'
            ? 'optional'
            : isComplete
              ? 'complete'
              : isNext
                ? 'next'
                : 'pending';
          const statusLabel = task.id === 'search'
            ? '按需'
            : isComplete
              ? '已完成'
              : isNext
                ? '下一步'
                : '待完成';

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
          onTestCapability={props.actions.testCapability}
        />
      );
    case 'prices':
      return <ModelPriceEditor draft={props.draft} busy={props.busyAction !== null} onDraftChange={props.onDraftChange} />;
    case 'search':
      return <SearchProfilePanel {...props} />;
    case 'review':
      return <PublishReview {...props} />;
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
  if (props.state.section === 'review' || props.state.section === 'search') return null;

  return (
    <footer className="family-model-settings-mobile-footer">
      {props.errorMessage ? <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p> : null}
      <div>
        {props.state.section === 'overview' ? (
          <button className="solid-button family-model-settings-mobile-primary-cta" type="button" disabled={busy} onClick={() => props.onPushMobileTask(props.overview.primarySection)}>
            <span>{props.overview.primaryLabel}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ) : (
          <>
            <button className="ghost-button" type="button" disabled={busy} onClick={() => props.onPushMobileTask('review')}>
              前往复核
            </button>
            <button className="solid-button" type="button" disabled={busy || !props.state.dirty} onClick={() => { void props.onSaveDraft(); }}>
              {busy ? '正在保存' : '保存草稿'}
            </button>
          </>
        )}
      </div>
    </footer>
  );
}

/** A phone-first task shell; it intentionally does not reuse desktop layout JSX. */
export function FamilyModelSettingsMobilePage(props: FamilyModelSettingsSurfaceProps) {
  const busy = props.busyAction !== null;
  const isOverview = props.state.section === 'overview';

  return (
    <main className="family-model-settings-mobile-page" aria-label="手机家庭 AI 服务" aria-busy={busy || undefined}>
      <header className="family-model-settings-mobile-header">
        <button
          className="family-model-settings-mobile-back"
          type="button"
          disabled={busy}
          onClick={isOverview ? props.onBack : props.onPopMobileTask}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span>{isOverview ? '返回家庭' : '返回服务概览'}</span>
        </button>
        <strong>{taskTitle(props.state.section)}</strong>
        <span className="family-model-settings-mobile-header-spacer" aria-hidden="true" />
      </header>
      <div className="family-model-settings-mobile-scroll">
        {props.stale ? <p className="family-model-settings-stale" role="status">刷新失败，正在显示上次成功的非敏感数据。</p> : null}
        <MobileTaskBody {...props} />
      </div>
      <MobileFooter {...props} />
    </main>
  );
}

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
  { id: 'providers', label: 'Provider 档案', description: '创建固定服务范围的档案与凭据。' },
  { id: 'capabilities', label: '能力配置', description: '选择需要启用的七类模型能力。' },
  { id: 'prices', label: '模型价格', description: '补齐启用能力的全部计价规则。' },
  { id: 'search', label: '搜索索引', description: '查看或安全地替换家庭搜索索引。' },
  { id: 'review', label: '发布复核', description: '检查能力、价格和搜索影响后发布。' },
];

function taskTitle(section: FamilyModelSettingsSection): string {
  if (section === 'overview') return '家庭 AI 服务';
  return MOBILE_TASKS.find((task) => task.id === section)?.label ?? '家庭 AI 服务';
}

function MobileOverview(props: FamilyModelSettingsSurfaceProps) {
  return (
    <>
      <section className="family-model-settings-mobile-summary" aria-labelledby="family-model-settings-mobile-summary-title">
        <span className={`family-model-settings-publication is-${props.overview.publication.kind}`}>{props.overview.publication.label}</span>
        <h1 id="family-model-settings-mobile-summary-title">家庭 AI 服务</h1>
        <span>{props.overview.publication.description}</span>
        <p className="family-model-settings-overview-summary">
          {props.overview.providerCount} 个服务档案 · {props.overview.enabledCapabilityCount} 类能力 · {props.overview.pricedCapabilityCount}/{props.overview.enabledCapabilityCount} 类价格就绪
        </p>
      </section>
      <nav className="family-model-settings-mobile-task-list" aria-label="家庭 AI 服务任务">
        {MOBILE_TASKS.map((task) => (
          <button
            key={task.id}
            type="button"
            aria-label={task.label}
            disabled={props.busyAction !== null}
            onClick={() => props.onPushMobileTask(task.id)}
          >
            <span>
              <strong>{task.label}</strong>
              <small>{task.description}</small>
            </span>
            <span className="family-model-settings-mobile-task-state">
              {task.id === 'search'
                ? '按需'
                : props.overview.steps.find((step) => step.id === task.id)?.status === 'complete'
                  ? '已完成'
                  : props.overview.primarySection === task.id ? '下一步' : '待完成'}
            </span>
          </button>
        ))}
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
          <button className="solid-button" type="button" disabled={busy} onClick={() => props.onPushMobileTask(props.overview.primarySection)}>
            {props.overview.primaryLabel}
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
          className="tertiary-button"
          type="button"
          disabled={busy}
          onClick={isOverview ? props.onBack : props.onPopMobileTask}
        >
          {isOverview ? '返回家庭' : '返回服务概览'}
        </button>
        <strong>{taskTitle(props.state.section)}</strong>
        <span aria-hidden="true" />
      </header>
      <div className="family-model-settings-mobile-scroll">
        {props.stale ? <p className="family-model-settings-stale" role="status">刷新失败，正在显示上次成功的非敏感数据。</p> : null}
        <MobileTaskBody {...props} />
      </div>
      <MobileFooter {...props} />
    </main>
  );
}

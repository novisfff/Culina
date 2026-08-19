import type { FamilyModelSettingsSection } from './useFamilyModelSettingsState';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ModelPriceEditor } from './ModelPriceEditor';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { PublishReview } from './PublishReview';
import { SearchProfilePanel } from './SearchProfilePanel';

const SECTIONS: ReadonlyArray<{ id: FamilyModelSettingsSection; label: string; description: string }> = [
  { id: 'overview', label: '服务概览', description: '查看当前配置状态' },
  { id: 'providers', label: 'Provider 档案', description: '管理服务地址与凭据' },
  { id: 'capabilities', label: '能力配置', description: '绑定七类模型能力' },
  { id: 'prices', label: '模型价格', description: '补全计价规则' },
  { id: 'search', label: '搜索索引', description: '管理向量索引切换' },
  { id: 'review', label: '发布复核', description: '检查并发布配置' },
];

function Overview(props: Pick<FamilyModelSettingsSurfaceProps, 'settings' | 'draft' | 'onSelectSection'>) {
  const enabledCount = props.draft.bindings.filter((binding) => binding.enabled).length;
  return (
    <section className="family-model-settings-overview" aria-labelledby="family-model-settings-overview-title">
      <div className="family-model-settings-overview-head">
        <div>
          <h2 id="family-model-settings-overview-title">{props.settings.active_config_revision_id ? '当前家庭 AI 服务' : '尚未配置服务'}</h2>
          <p>{props.settings.active_config_revision_id ? '当前发布配置正在为家庭提供服务。' : '先创建 Provider 档案，绑定需要的能力和价格，再检查并发布。'}</p>
        </div>
      </div>
      <div className="family-model-settings-overview-grid">
        <article><strong>{props.settings.provider_profiles.length}</strong><span>Provider 档案</span></article>
        <article><strong>{enabledCount}</strong><span>已启用能力</span></article>
        <article><strong>{props.draft.price_rates.length}</strong><span>草稿价格规则</span></article>
      </div>
      <div className="family-model-settings-overview-actions">
        <button className="solid-button" type="button" onClick={() => props.onSelectSection('providers')}>创建 Provider 档案</button>
        <button className="ghost-button" type="button" onClick={() => props.onSelectSection('capabilities')}>配置能力</button>
      </div>
    </section>
  );
}

export function FamilyModelSettingsDesktopView(props: FamilyModelSettingsSurfaceProps) {
  const busy = props.busyAction !== null;
  const selectedProfileId = props.state.selectedProfileId;

  return (
    <main className="family-model-settings-workspace family-model-settings-desktop" aria-busy={busy || undefined}>
      <nav className="family-model-settings-section-rail" aria-label="家庭 AI 服务设置分区">
        <div className="family-model-settings-rail-head">
          <span>家庭设置</span>
          <strong>AI 服务</strong>
        </div>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={props.state.section === section.id ? 'page' : undefined}
            disabled={busy}
            onClick={() => props.onSelectSection(section.id)}
          >
            <strong>{section.label}</strong>
            <small>{section.description}</small>
          </button>
        ))}
      </nav>
      <section className="family-model-settings-main-panel" aria-labelledby="family-model-settings-title">
        <header className="family-model-settings-page-head">
          <div>
            <button className="tertiary-button family-model-settings-back" type="button" disabled={busy} onClick={props.onBack}>返回家庭</button>
            <p>家庭工作区</p>
            <h1 id="family-model-settings-title">家庭 AI 服务</h1>
            <span>由家庭主理人统一管理服务、凭据、模型和价格。</span>
          </div>
          {props.stale ? <p className="family-model-settings-stale" role="status">刷新失败，正在显示上次成功的非敏感数据。</p> : null}
        </header>

        {props.state.section === 'overview' ? <Overview settings={props.settings} draft={props.draft} onSelectSection={props.onSelectSection} /> : null}
        {props.state.section === 'providers' ? (
          <ProviderProfileEditor
            profiles={props.settings.provider_profiles}
            settingsVersionNumber={props.settings.version_number}
            selectedProfileId={selectedProfileId}
            busy={busy}
            onSelectProfile={props.onSelectProfile}
            onRebindCreatedProfile={props.onRebindCreatedProfile}
            onCreate={(input) => props.actions.createProviderProfile({ ...input, idempotency_key: '' })}
            onPatch={(profileId, input) => props.actions.patchProviderProfile(profileId, { ...input, idempotency_key: '' })}
            onRotate={(profileId, input) => props.actions.rotateProviderProfileKey(profileId, input)}
            onCheck={(profileId) => props.actions.checkProviderConnection(profileId)}
          />
        ) : null}
        {props.state.section === 'capabilities' ? (
          <CapabilityBindingEditor
            draft={props.draft}
            profiles={props.settings.provider_profiles}
            busy={busy}
            onDraftChange={props.onDraftChange}
            onTestCapability={props.actions.testCapability}
          />
        ) : null}
        {props.state.section === 'prices' ? <ModelPriceEditor draft={props.draft} busy={busy} onDraftChange={props.onDraftChange} /> : null}
        {props.state.section === 'search' ? <SearchProfilePanel {...props} /> : null}
        {props.state.section === 'review' ? <PublishReview {...props} /> : null}

        {props.state.section !== 'review' && props.state.section !== 'overview' ? (
          <footer className="family-model-settings-desktop-footer">
            <div>
              {props.errorMessage ? <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p> : null}
              {props.state.dirty ? <span>有未保存的草稿修改</span> : <span>草稿已同步</span>}
            </div>
            <div className="family-model-settings-editor-actions">
              <button className="ghost-button" type="button" disabled={busy || !props.state.dirty} onClick={() => { void props.onSaveDraft(); }}>保存草稿</button>
              <button className="tertiary-button" type="button" disabled={busy} onClick={() => props.onSelectSection('review')}>前往发布复核</button>
            </div>
          </footer>
        ) : null}
      </section>
    </main>
  );
}

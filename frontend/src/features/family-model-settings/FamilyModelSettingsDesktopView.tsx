import type { ReactNode } from 'react';
import type { FamilyModelSettingsSection } from './useFamilyModelSettingsState';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ModelPriceEditor } from './ModelPriceEditor';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { ConfigurationCheck } from './ConfigurationCheck';
import { SearchProfilePanel } from './SearchProfilePanel';

const SECTIONS: ReadonlyArray<{ id: FamilyModelSettingsSection; label: string; description: string }> = [
  { id: 'overview', label: '服务概览', description: '查看当前配置状态' },
  { id: 'providers', label: 'Provider 服务', description: '管理连接地址与凭据' },
  { id: 'capabilities', label: '能力配置', description: '绑定七类模型能力' },
  { id: 'prices', label: '模型价格', description: '可选，未填按 0 计算' },
  { id: 'search', label: '搜索索引', description: '管理向量索引切换' },
  { id: 'review', label: '配置检查', description: '查看配置完善度' },
];

function renderSectionIcon(id: FamilyModelSettingsSection): ReactNode {
  switch (id) {
    case 'overview':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      );
    case 'providers':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="6" rx="2" />
          <rect x="3" y="14" width="18" height="6" rx="2" />
          <circle cx="7" cy="7" r="1" fill="currentColor" />
          <circle cx="7" cy="17" r="1" fill="currentColor" />
          <path d="M11 7h6M11 17h6" />
        </svg>
      );
    case 'capabilities':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2Z" />
          <path d="M18.5 15.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" />
        </svg>
      );
    case 'prices':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
          <circle cx="7" cy="7" r="1.5" fill="currentColor" />
        </svg>
      );
    case 'search':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7.5" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
      );
    case 'review':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
  }
}

function Overview(props: Pick<FamilyModelSettingsSurfaceProps, 'overview' | 'onSelectSection'>) {
  const { overview } = props;
  return (
    <section className="family-model-settings-overview" aria-labelledby="family-model-settings-overview-title">
      <div className="family-model-settings-overview-primary">
        <div className="family-model-settings-overview-primary-copy">
          <div className="family-model-settings-overview-status-row">
            <span className={`family-model-settings-configuration-status is-${overview.configurationStatus.kind}`}>
              <span className="family-model-settings-status-dot" aria-hidden="true" />
              {overview.configurationStatus.label}
            </span>
          </div>
          <h2 id="family-model-settings-overview-title">{overview.title}</h2>
          <p>{overview.configurationStatus.description}</p>
        </div>
        <button className="solid-button family-model-settings-primary-cta" type="button" onClick={() => props.onSelectSection(overview.primarySection)}>
          <span>{overview.primaryLabel}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>

      <div className="family-model-settings-steps-section">
        <div className="family-model-settings-steps-header">
          <div className="family-model-settings-steps-header-title">
            <h3>配置引导</h3>
            <p>连接服务并绑定需要的能力即可使用；价格和完整度检查可按需查看</p>
          </div>
          <span className="family-model-settings-steps-badge">自动保存</span>
        </div>
        <ol className="family-model-settings-setup-steps" aria-label="家庭 AI 服务配置进度">
          {overview.steps.map((step) => (
            <li key={step.id} className={`is-${step.status}`}>
              <button type="button" onClick={() => props.onSelectSection(step.id)}>
                <div className="family-model-settings-step-card-top">
                  <span className="family-model-settings-step-index" aria-hidden="true">
                    {step.status === 'complete' ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    ) : (
                      `0${step.number}`
                    )}
                  </span>
                  <span className={`family-model-settings-step-state is-${step.status}`}>
                    {step.status === 'complete'
                      ? '已完成'
                      : step.id === 'prices' || step.id === 'review'
                        ? '按需'
                        : step.status === 'current'
                          ? '下一步'
                          : '待完成'}
                  </span>
                </div>
                <div className="family-model-settings-step-card-body">
                  <strong>{step.number}. {step.label}</strong>
                  <small>{step.description}</small>
                </div>
                <div className="family-model-settings-step-card-footer" aria-hidden="true">
                  <span>{step.status === 'complete'
                    ? '查看配置'
                    : step.id === 'prices' || step.id === 'review'
                      ? '按需查看'
                      : step.status === 'current'
                        ? '立即开始'
                        : '前往配置'}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </div>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="family-model-settings-overview-metrics-section">
        <div className="family-model-settings-overview-metrics" aria-label="配置概览指标">
          <article className="family-model-settings-metric-tile">
            <div className="family-model-settings-metric-tile-icon tone-provider" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="6" rx="2" />
                <rect x="2" y="14" width="20" height="6" rx="2" />
                <path d="M6 7h.01M6 17h.01M10 7h4M10 17h4" />
              </svg>
            </div>
            <div className="family-model-settings-metric-tile-content">
              <span>Provider 服务</span>
              <strong>{overview.providerCount} <small>个</small></strong>
            </div>
            <span className={`family-model-settings-metric-tile-badge ${overview.providerCount > 0 ? 'is-ready' : 'is-pending'}`}>
              {overview.providerCount > 0 ? '已连接' : '待配置'}
            </span>
          </article>

          <article className="family-model-settings-metric-tile">
            <div className="family-model-settings-metric-tile-icon tone-capability" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
                <path d="M19 15l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" />
              </svg>
            </div>
            <div className="family-model-settings-metric-tile-content">
              <span>已启用能力</span>
              <strong>{overview.enabledCapabilityCount} <small>/ 7 类</small></strong>
            </div>
            <span className={`family-model-settings-metric-tile-badge ${overview.enabledCapabilityCount > 0 ? 'is-ready' : 'is-pending'}`}>
              {overview.enabledCapabilityCount > 0 ? '已开启' : '未开启'}
            </span>
          </article>

          <article className="family-model-settings-metric-tile">
            <div className="family-model-settings-metric-tile-icon tone-price" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div className="family-model-settings-metric-tile-content">
              <span>已填写价格</span>
              <strong>{overview.pricedCapabilityCount} <small>/ {overview.enabledCapabilityCount} 类</small></strong>
            </div>
            <span className={`family-model-settings-metric-tile-badge ${overview.enabledCapabilityCount > 0 && overview.pricedCapabilityCount === overview.enabledCapabilityCount ? 'is-ready' : 'is-pending'}`}>
              {overview.enabledCapabilityCount === 0
                ? '暂无能力'
                : overview.pricedCapabilityCount === overview.enabledCapabilityCount
                  ? '已填写'
                  : '未填按 0'}
            </span>
          </article>
        </div>
        <p className="family-model-settings-overview-summary">
          {overview.providerCount} 个服务 · {overview.enabledCapabilityCount} 类已启用能力 · {overview.pricedCapabilityCount}/{overview.enabledCapabilityCount} 类已填写价格
        </p>
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
        <div className="family-model-settings-rail-list">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`family-model-settings-rail-item ${props.state.section === section.id ? 'is-active' : ''}`}
              aria-current={props.state.section === section.id ? 'page' : undefined}
              disabled={busy}
              onClick={() => props.onSelectSection(section.id)}
            >
              <span className="family-model-settings-rail-item-icon" aria-hidden="true">
                {renderSectionIcon(section.id)}
              </span>
              <span className="family-model-settings-rail-item-copy">
                <strong>{section.label}</strong>
                <small>{section.description}</small>
              </span>
              <span className="family-model-settings-rail-item-indicator" aria-hidden="true" />
            </button>
          ))}
        </div>
      </nav>
      <section className="family-model-settings-main-panel" aria-labelledby="family-model-settings-title">
        <header className="family-model-settings-page-head">
          <div className="family-model-settings-page-head-top">
            <button className="family-model-settings-back" type="button" disabled={busy} onClick={props.onBack}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
              <span>返回家庭</span>
            </button>
            <span className="family-model-settings-page-head-tag">家庭工作区</span>
          </div>
          <div className="family-model-settings-page-head-main">
            <div className="family-model-settings-page-head-title-wrap">
              <div className="family-model-settings-page-head-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
                  <path d="M19 4v3" />
                  <path d="M20.5 5.5h-3" />
                  <path d="M18 16v2" />
                  <path d="M19 17h-2" />
                </svg>
              </div>
              <div>
                <h1 id="family-model-settings-title">家庭 AI 服务</h1>
                <p className="family-model-settings-page-head-desc">由家庭主理人统一管理服务、凭据、模型和价格。</p>
              </div>
            </div>
          </div>
          {props.stale ? <p className="family-model-settings-stale" role="status">刷新失败，正在显示上次成功的非敏感数据。</p> : null}
          {props.errorMessage ? (
            <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p>
          ) : (
            <p className={`family-model-settings-auto-save-status ${props.serverDraft.validation_status === 'invalid' ? 'is-warning' : 'is-ready'}`} role="status">
              <span className="family-model-settings-status-dot" aria-hidden="true" />
              {props.busyAction === 'save'
                ? '正在自动保存…'
                : props.state.dirty
                  ? '修改将在稍后自动保存'
                  : props.serverDraft.validation_status === 'invalid'
                    ? '修改已保存，配置仍可继续完善；当前可用配置不受影响'
                    : props.settings.active_config_revision_id
                      ? '配置已自动保存并生效'
                      : '修改会自动保存，信息完整后立即生效'}
            </p>
          )}
        </header>

        {props.state.section === 'overview' ? <Overview overview={props.overview} onSelectSection={props.onSelectSection} /> : null}
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
            onDiscoverModels={props.onDiscoverModels}
            onTestCapability={props.onTestCapability}
          />
        ) : null}
        {props.state.section === 'prices' ? <ModelPriceEditor draft={props.draft} busy={busy} onDraftChange={props.onDraftChange} /> : null}
        {props.state.section === 'search' ? <SearchProfilePanel {...props} /> : null}
        {props.state.section === 'review' ? <ConfigurationCheck {...props} /> : null}
      </section>
    </main>
  );
}

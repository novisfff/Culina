import { useMemo, useState } from 'react';
import type {
  FamilyModelBindingDraft,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelPriceRate,
  FamilyModelSearchReplacementPreviewResult,
} from '../../api/types/modelUsage';
import { ConfirmDialog, DropdownSelect } from '../../components/ui-kit';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import type { FamilyModelSettingsDraft } from './familyModelSettingsModel';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';
import { FAMILY_MODEL_ADAPTER_OPTIONS, profileSupportsCapability } from './familyModelSettingsOptions';

type SearchProfilePanelProps = Pick<FamilyModelSettingsSurfaceProps,
  | 'settings'
  | 'draft'
  | 'actions'
  | 'busyAction'
  | 'searchReplacement'
  | 'replacementProfileId'
  | 'onReplacementProfileIdChange'
  | 'onDraftChange'
  | 'onConfirmInitialSearchIndex'
  | 'onDiscoverModels'
  | 'onTestCapability'
>;

const SEARCH_REPLACEMENT_STATUS_LABELS: Record<string, string> = {
  provisioning: '更新中',
  failed: '更新失败',
  active: '已启用',
  cancelled: '已取消',
  superseded: '已替换',
  retired: '已停用',
};

function searchReplacementStatusLabel(status: string) {
  return SEARCH_REPLACEMENT_STATUS_LABELS[status] ?? '处理中';
}

function findEmbedding(draft: FamilyModelSettingsDraft): FamilyModelEmbeddingBindingDraft {
  const binding = draft.bindings.find(
    (item): item is FamilyModelEmbeddingBindingDraft => item.capability === 'embedding',
  );
  if (!binding) throw new Error('搜索模型配置缺失。');
  return binding;
}

function replaceBinding(
  draft: FamilyModelSettingsDraft,
  replacement: FamilyModelBindingDraft,
): FamilyModelSettingsDraft {
  return {
    ...draft,
    bindings: draft.bindings.map((binding) => (
      binding.capability === replacement.capability && binding.variant_key === replacement.variant_key
        ? replacement
        : binding
    )),
  };
}

function bindingEqual(left: FamilyModelBindingDraft, right: FamilyModelBindingDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function embeddingReady(binding: FamilyModelEmbeddingBindingDraft): boolean {
  return binding.enabled
    && Boolean(binding.provider_profile_id)
    && binding.requested_model.trim().length > 0
    && binding.dimensions > 0;
}

export function SearchProfilePanel(props: SearchProfilePanelProps) {
  const [pendingEmbedding, setPendingEmbedding] = useState<FamilyModelEmbeddingBindingDraft | null>(null);
  const [initialConfirmOpen, setInitialConfirmOpen] = useState(false);
  const [replacementEditorOpen, setReplacementEditorOpen] = useState(false);
  const [providerProfileId, setProviderProfileId] = useState('');
  const [requestedModel, setRequestedModel] = useState('');
  const [dimensions, setDimensions] = useState('1536');
  const [preview, setPreview] = useState<FamilyModelSearchReplacementPreviewResult | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const embeddingProfiles = useMemo(
    () => props.settings.provider_profiles.filter((profile) => profileSupportsCapability(profile, 'embedding')),
    [props.settings.provider_profiles],
  );
  const workingDraft = useMemo(
    () => pendingEmbedding ? replaceBinding(props.draft, pendingEmbedding) : props.draft,
    [pendingEmbedding, props.draft],
  );
  const embedding = findEmbedding(workingDraft);
  const busy = props.busyAction !== null;
  const activeSearchProfileId = props.settings.active_search_profile_id ?? null;
  const configuredSearchProfileId = props.draft.search_profile_id ?? activeSearchProfileId;
  const replacement = props.searchReplacement;
  const replacementIsCandidate = Boolean(
    replacement
      && replacement.status !== 'active'
      && replacement.status !== 'cancelled'
      && replacement.profile_id !== activeSearchProfileId,
  );
  const replacementWasCancelled = Boolean(
    replacement
      && replacement.status === 'cancelled'
      && replacement.profile_id !== activeSearchProfileId,
  );
  const rates = props.draft.price_rates.filter((rate) => rate.capability === 'embedding');
  const isInitialReady = !configuredSearchProfileId && embeddingReady(embedding);

  const summary = (() => {
    if (replacementIsCandidate && replacement?.status === 'provisioning') {
      return {
        title: '正在准备智能搜索',
        description: '搜索模型已确认，正在更新家庭内容的搜索数据。',
        tone: 'is-progress',
      };
    }
    if (replacementIsCandidate && replacement?.status === 'failed') {
      return {
        title: '智能搜索准备失败',
        description: activeSearchProfileId
          ? '原搜索模型设置仍保留，可以在下方重试；已完成的内容不会重复处理。'
          : '首次搜索配置尚未启用，可以重试，也可以放弃后重新配置模型。',
        tone: 'is-danger',
      };
    }
    if (replacementWasCancelled) {
      return {
        title: '搜索索引重建已取消',
        description: '当前仍继续使用原有搜索索引；如需更换向量模型，可以重新开始重建。',
        tone: 'is-warning',
      };
    }
    if (activeSearchProfileId) {
      return {
        title: '当前智能搜索已启用',
        description: '当前搜索设置已生效；更换模型服务、模型或维度时，需要重新生成搜索数据。',
        tone: 'is-ready',
      };
    }
    if (configuredSearchProfileId) {
      return {
        title: '智能搜索已配置',
        description: '搜索模型已确认，正在更新家庭内容的搜索数据。',
        tone: 'is-progress',
      };
    }
    if (isInitialReady) {
      return {
        title: '智能搜索待确认',
        description: '确认后会为家庭内容开启智能搜索；之后更换搜索模型时，需要重新生成搜索数据。',
        tone: 'is-warning',
      };
    }
    if (embedding.enabled) {
      return {
        title: '搜索模型配置未完成',
        description: '请补全模型服务、模型名称和模型维度，再确认开启搜索。',
        tone: 'is-warning',
      };
    }
    return {
      title: '未配置智能搜索',
      description: '先配置并确认搜索模型，系统才会为家庭内容准备智能搜索。',
      tone: '',
    };
  })();

  function handleSearchDraftChange(nextDraft: FamilyModelSettingsDraft) {
    const currentEmbedding = findEmbedding(workingDraft);
    const nextEmbedding = findEmbedding(nextDraft);
    const currentRerank = workingDraft.bindings.find((binding) => binding.capability === 'rerank');
    const nextRerank = nextDraft.bindings.find((binding) => binding.capability === 'rerank');

    if (!bindingEqual(currentEmbedding, nextEmbedding)) {
      const serverEmbedding = findEmbedding(props.draft);
      setPendingEmbedding(bindingEqual(serverEmbedding, nextEmbedding) ? null : nextEmbedding);
    }
    if (currentRerank && nextRerank && !bindingEqual(currentRerank, nextRerank)) {
      props.onDraftChange(replaceBinding(nextDraft, findEmbedding(props.draft)));
    }
  }

  async function confirmInitialSearchIndex() {
    try {
      await props.onConfirmInitialSearchIndex(workingDraft);
      setPendingEmbedding(null);
      setInitialConfirmOpen(false);
    } catch {
      // The workspace keeps the safe server error visible and the staged identity intact.
    }
  }

  function baseInput() {
    return {
      base_settings_version_number: props.settings.version_number,
      base_search_profile_id: activeSearchProfileId ?? '',
      provider_profile_id: providerProfileId,
      requested_model: requestedModel.trim(),
      dimensions: Number(dimensions) || 0,
      rates: rates as FamilyModelPriceRate[],
    };
  }

  async function previewReplacement() {
    if (!activeSearchProfileId) return;
    try {
      const result = await props.actions.previewSearchReplacement(baseInput());
      setPreview(result);
      setConfirmed(false);
    } catch {
      setPreview(null);
    }
  }

  async function startReplacement() {
    if (!preview) return;
    try {
      const result = await props.actions.createSearchReplacement({
        ...baseInput(),
        confirm_checksum: preview.confirmation_checksum,
        current_password: currentPassword,
      });
      props.onReplacementProfileIdChange(result.profile_id);
      setCurrentPassword('');
      setConfirmed(false);
      setReplacementEditorOpen(false);
    } catch {
      // The workspace keeps a safe recovery message visible.
    }
  }

  async function retryReplacement() {
    if (!replacement) return;
    try {
      await props.actions.retrySearchReplacement(replacement.profile_id, {
        base_settings_version_number: props.settings.version_number,
      });
      props.onReplacementProfileIdChange(replacement.profile_id);
    } catch {
      // The failed state remains visible for a safe retry.
    }
  }

  async function cancelReplacement() {
    if (!replacement) return;
    try {
      await props.actions.cancelSearchReplacement(replacement.profile_id, {
        base_settings_version_number: props.settings.version_number,
      });
      props.onReplacementProfileIdChange(null);
    } catch {
      // Preserve the operation state until the server settles it.
    }
  }

  return (
    <section className="family-model-settings-editor family-model-settings-search-editor" aria-labelledby="family-model-search-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-search-title">智能搜索</h2>
          <p>在这里统一管理家庭内容的搜索方式。更新期间会继续使用当前搜索。</p>
        </div>
      </div>

      <div className={`family-model-settings-search-summary ${summary.tone}`} aria-live="polite">
        <strong>{summary.title}</strong>
        <span>{summary.description}</span>
      </div>

      {replacement && (replacementIsCandidate || replacementWasCancelled) ? (
        <section className="family-model-settings-search-progress" aria-live="polite">
          <div>
            <h3>{activeSearchProfileId ? '智能搜索更新进度' : '首次启用智能搜索'}</h3>
            <p>{replacement.status === 'provisioning' ? '正在更新家庭内容的搜索数据，可继续使用当前搜索。' : replacement.status === 'failed' ? '搜索数据更新失败，现有搜索没有被替换。' : `当前状态：${searchReplacementStatusLabel(replacement.status)}`}</p>
          </div>
          <strong>{replacement.indexed_documents} / {replacement.total_documents}</strong>
          {replacement.failed_documents > 0 ? <span>失败 {replacement.failed_documents} 项</span> : null}
          {replacement.failure ? (
            <div className="family-model-settings-search-failure" role="alert">
              <strong>{replacement.failure.detail}</strong>
              {replacement.failure.provider_http_status ? <span>Provider HTTP {replacement.failure.provider_http_status}</span> : null}
              {replacement.failure.provider_error_code ? <span>错误码：{replacement.failure.provider_error_code}</span> : null}
              {replacement.failure.provider_error_message ? <span>{replacement.failure.provider_error_message}</span> : null}
              {replacement.failure.execution_certainty === 'unknown' ? <span>请求执行结果暂时无法确认，请先检查用量记录后再重试。</span> : null}
            </div>
          ) : null}
          <div className="family-model-settings-editor-actions">
            {replacement.status === 'failed' && replacement.retryable ? <button className="ghost-button" type="button" disabled={busy} onClick={() => { void retryReplacement(); }}>重试更新</button> : null}
            {activeSearchProfileId && (replacement.status === 'provisioning' || replacement.status === 'failed') ? <button className="tertiary-button" type="button" disabled={busy} onClick={() => { void cancelReplacement(); }}>取消更新</button> : null}
            {!activeSearchProfileId && replacement.status === 'failed' ? <button className="tertiary-button" type="button" disabled={busy} onClick={() => { void cancelReplacement(); }}>放弃并重新配置</button> : null}
          </div>
        </section>
      ) : null}

      <section className="family-model-settings-search-capabilities" aria-labelledby="family-model-search-capabilities-title">
        <div className="family-model-settings-subsection-head">
          <div>
            <h3 id="family-model-search-capabilities-title">搜索模型</h3>
            <p>搜索模型决定如何理解家庭内容；结果排序只影响展示顺序，可独立调整。</p>
          </div>
        </div>
        <CapabilityBindingEditor
          draft={workingDraft}
          profiles={props.settings.provider_profiles}
          busy={busy}
          scope="search"
          embedded
          blockedTests={!configuredSearchProfileId ? ['embedding'] : undefined}
          onDraftChange={handleSearchDraftChange}
          onDiscoverModels={props.onDiscoverModels}
          onTestCapability={props.onTestCapability}
        />
        {!configuredSearchProfileId ? (
          <div className="family-model-settings-initial-search-action">
            <div>
              <strong>确认后会保存搜索模型设置</strong>
              <span>后续更换模型服务、搜索模型或维度时，需要重新生成搜索数据。</span>
            </div>
            <button className="solid-button" type="button" disabled={busy || !isInitialReady} onClick={() => setInitialConfirmOpen(true)}>
              确认搜索模型
            </button>
          </div>
        ) : null}
      </section>

      {activeSearchProfileId ? (
        <section className="family-model-settings-search-danger-zone" aria-labelledby="family-model-search-danger-title">
          <div>
            <span>需要谨慎确认</span>
            <h3 id="family-model-search-danger-title">更换搜索模型</h3>
            <p>更换模型服务、搜索模型或维度时，需要重新生成搜索数据。更新完成前继续使用当前搜索，成功后再切换。</p>
          </div>
          {!replacementEditorOpen ? (
            <button className="family-model-settings-danger-action" type="button" disabled={busy} onClick={() => setReplacementEditorOpen(true)}>
              更换搜索模型
            </button>
          ) : (
            <div className="family-model-settings-search-replacement">
              <div className="family-model-settings-form-grid">
                <div className="family-model-settings-field">
                  <span>新的模型服务</span>
                  <DropdownSelect
                    ariaLabel="新的模型服务选项"
                    triggerAriaLabel="新的模型服务"
                    placeholder="选择兼容服务"
                    value={providerProfileId}
                    options={embeddingProfiles.map((profile) => ({
                      value: profile.id,
                      label: profile.display_name,
                      description: FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === profile.adapter_kind)?.label
                        ?? profile.adapter_kind,
                    }))}
                    clearOption={{
                      value: '',
                      label: '选择兼容服务',
                      description: '选择用于新搜索配置的模型服务。',
                    }}
                    disabled={busy}
                    className="family-model-settings-dropdown"
                    onChange={(value) => { setProviderProfileId(value); setPreview(null); }}
                  />
                </div>
                <label className="family-model-settings-field">
                  <span>新的搜索模型</span>
                  <input value={requestedModel} disabled={busy} onChange={(event) => { setRequestedModel(event.target.value); setPreview(null); }} placeholder="输入模型名称" />
                </label>
                <label className="family-model-settings-field">
                  <span>模型维度</span>
                  <input type="number" min="1" value={dimensions} disabled={busy} onChange={(event) => { setDimensions(event.target.value); setPreview(null); }} />
                </label>
              </div>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={busy} onClick={() => { setReplacementEditorOpen(false); setPreview(null); }}>取消</button>
                <button className="family-model-settings-danger-action" type="button" disabled={busy || !providerProfileId || !requestedModel.trim() || rates.length === 0} onClick={() => { void previewReplacement(); }}>查看更新范围</button>
              </div>
              {preview ? (
                <section className="family-model-settings-search-confirmation">
                  <strong>预计更新 {preview.document_count} 项家庭内容的搜索数据</strong>
                  <p>预计费用约 ¥{preview.conservative_estimated_cost_cny}。更新期间继续使用当前搜索，完成后才会切换。</p>
                  <label className="family-model-settings-field">
                    <span>当前密码</span>
                    <input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(event) => setCurrentPassword(event.target.value)} />
                  </label>
                  <label className="family-model-settings-checkbox-field">
                    <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                    <span>我确认更换搜索模型，并了解系统会重新生成全部家庭内容的搜索数据。</span>
                  </label>
                  <div className="family-model-settings-editor-actions">
                    <button className="ghost-button" type="button" disabled={busy} onClick={() => setPreview(null)}>返回修改</button>
                    <button className="family-model-settings-danger-action" type="button" disabled={busy || !currentPassword || !confirmed} onClick={() => { void startReplacement(); }}>{busy ? '正在开始' : '确认并开始更新'}</button>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <ConfirmDialog
        open={initialConfirmOpen}
        title="确认开启智能搜索"
        description={(
          <div className="family-model-settings-initial-confirm-copy">
            <p>确认后，系统会使用 <strong>{embedding.requested_model}</strong>（{embedding.dimensions} 维）为家庭内容生成搜索数据，并开启智能搜索。</p>
            <p>今后更换搜索模型、模型服务或维度时，需要重新生成搜索数据。更新完成前会继续使用当前搜索。</p>
          </div>
        )}
        confirmLabel="确认并开启搜索"
        cancelLabel="返回检查"
        isSubmitting={busy}
        rootClassName="family-model-settings-confirm-root"
        modalClassName="family-model-settings-confirm-modal"
        onConfirm={() => { void confirmInitialSearchIndex(); }}
        onCancel={() => setInitialConfirmOpen(false)}
      />
    </section>
  );
}

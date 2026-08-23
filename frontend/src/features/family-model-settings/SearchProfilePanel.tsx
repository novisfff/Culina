import { useMemo, useState } from 'react';
import type {
  FamilyModelBindingDraft,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelPriceRate,
  FamilyModelSearchReplacementPreviewResult,
} from '../../api/types';
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

function findEmbedding(draft: FamilyModelSettingsDraft): FamilyModelEmbeddingBindingDraft {
  const binding = draft.bindings.find(
    (item): item is FamilyModelEmbeddingBindingDraft => item.capability === 'embedding',
  );
  if (!binding) throw new Error('搜索向量配置缺失。');
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
  const activeSearchProfileId = props.settings.active_search_profile_id;
  const configuredSearchProfileId = props.draft.search_profile_id ?? activeSearchProfileId;
  const replacement = props.searchReplacement;
  const rates = props.draft.price_rates.filter((rate) => rate.capability === 'embedding');
  const isInitialReady = !configuredSearchProfileId && embeddingReady(embedding);

  const summary = (() => {
    if (replacement?.profile_id === configuredSearchProfileId && replacement.status === 'provisioning') {
      return {
        title: '正在建立搜索索引',
        description: '向量模型已经确认，系统正在为现有家庭内容建立索引。',
        tone: 'is-progress',
      };
    }
    if (replacement?.profile_id === configuredSearchProfileId && replacement.status === 'failed') {
      return {
        title: '搜索索引建立失败',
        description: '向量模型配置仍被保留，可以在下方重试，不会重复创建索引身份。',
        tone: 'is-danger',
      };
    }
    if (activeSearchProfileId) {
      return {
        title: '当前搜索索引已启用',
        description: '向量模型身份已锁定；更换 Provider、模型或维度会完整重建索引。',
        tone: 'is-ready',
      };
    }
    if (configuredSearchProfileId) {
      return {
        title: '搜索索引已配置',
        description: '向量模型已经锁定，系统正在同步索引状态。',
        tone: 'is-progress',
      };
    }
    if (isInitialReady) {
      return {
        title: '向量模型待确认',
        description: '确认后会为全部家庭内容建立搜索索引，之后更换向量身份需要完整重建。',
        tone: 'is-warning',
      };
    }
    if (embedding.enabled) {
      return {
        title: '向量模型配置尚未完成',
        description: '请补全 Provider、模型名称和向量维度，再确认建立索引。',
        tone: 'is-warning',
      };
    }
    return {
      title: '尚未配置搜索索引',
      description: '先配置并确认向量模型，系统才会为家庭内容建立语义索引。',
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
    } catch {
      // Preserve the operation state until the server settles it.
    }
  }

  return (
    <section className="family-model-settings-editor family-model-settings-search-editor" aria-labelledby="family-model-search-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-search-title">搜索索引</h2>
          <p>在这里统一管理搜索向量与结果重排。重建期间会继续使用当前可用索引。</p>
        </div>
      </div>

      <div className={`family-model-settings-search-summary ${summary.tone}`} aria-live="polite">
        <strong>{summary.title}</strong>
        <span>{summary.description}</span>
      </div>

      {replacement && replacement.status !== 'active' && replacement.status !== 'cancelled' ? (
        <section className="family-model-settings-search-progress" aria-live="polite">
          <div>
            <h3>{activeSearchProfileId ? '替换索引进度' : '首次索引进度'}</h3>
            <p>{replacement.status === 'provisioning' ? '正在完整建立索引，可继续使用当前可用的搜索方式。' : replacement.status === 'failed' ? '索引建立失败，现有可用索引没有被替换。' : `当前状态：${replacement.status}`}</p>
          </div>
          <strong>{replacement.indexed_documents} / {replacement.total_documents}</strong>
          {replacement.failed_documents > 0 ? <span>失败 {replacement.failed_documents} 项</span> : null}
          <div className="family-model-settings-editor-actions">
            {replacement.status === 'failed' && replacement.retryable ? <button className="ghost-button" type="button" disabled={busy} onClick={() => { void retryReplacement(); }}>重试建立索引</button> : null}
            {activeSearchProfileId && (replacement.status === 'provisioning' || replacement.status === 'failed') ? <button className="tertiary-button" type="button" disabled={busy} onClick={() => { void cancelReplacement(); }}>取消重建</button> : null}
          </div>
        </section>
      ) : null}

      <section className="family-model-settings-search-capabilities" aria-labelledby="family-model-search-capabilities-title">
        <div className="family-model-settings-subsection-head">
          <div>
            <h3 id="family-model-search-capabilities-title">搜索模型</h3>
            <p>搜索向量决定索引身份；搜索重排只影响结果顺序，可独立调整。</p>
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
              <strong>首次确认后会锁定向量身份</strong>
              <span>后续更换 Provider、向量模型或维度会进入高风险重建流程。</span>
            </div>
            <button className="solid-button" type="button" disabled={busy || !isInitialReady} onClick={() => setInitialConfirmOpen(true)}>
              确认向量模型
            </button>
          </div>
        ) : null}
      </section>

      {activeSearchProfileId ? (
        <section className="family-model-settings-search-danger-zone" aria-labelledby="family-model-search-danger-title">
          <div>
            <span>高风险操作</span>
            <h3 id="family-model-search-danger-title">更换向量模型</h3>
            <p>更换 Provider、向量模型或维度会建立一套全新索引。完成前继续使用当前索引，成功后再安全切换。</p>
          </div>
          {!replacementEditorOpen ? (
            <button className="family-model-settings-danger-action" type="button" disabled={busy} onClick={() => setReplacementEditorOpen(true)}>
              更换向量模型（高风险）
            </button>
          ) : (
            <div className="family-model-settings-search-replacement">
              <div className="family-model-settings-form-grid">
                <div className="family-model-settings-field">
                  <span>新的 Provider 服务</span>
                  <DropdownSelect
                    ariaLabel="新的 Provider 服务选项"
                    triggerAriaLabel="新的 Provider 服务"
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
                      description: '选择用于新搜索索引的 Embedding 服务。',
                    }}
                    disabled={busy}
                    className="family-model-settings-dropdown"
                    onChange={(value) => { setProviderProfileId(value); setPreview(null); }}
                  />
                </div>
                <label className="family-model-settings-field">
                  <span>新的向量模型</span>
                  <input value={requestedModel} disabled={busy} onChange={(event) => { setRequestedModel(event.target.value); setPreview(null); }} placeholder="输入向量模型标识" />
                </label>
                <label className="family-model-settings-field">
                  <span>向量维度</span>
                  <input type="number" min="1" value={dimensions} disabled={busy} onChange={(event) => { setDimensions(event.target.value); setPreview(null); }} />
                </label>
              </div>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={busy} onClick={() => { setReplacementEditorOpen(false); setPreview(null); }}>取消</button>
                <button className="family-model-settings-danger-action" type="button" disabled={busy || !providerProfileId || !requestedModel.trim() || rates.length === 0} onClick={() => { void previewReplacement(); }}>评估完整重建</button>
              </div>
              {preview ? (
                <section className="family-model-settings-search-confirmation">
                  <strong>预计重建 {preview.document_count} 份家庭文档</strong>
                  <p>保守费用约 ¥{preview.conservative_estimated_cost_cny}。重建期间继续使用当前索引，只有新索引完整成功后才会切换。</p>
                  <label className="family-model-settings-field">
                    <span>当前密码</span>
                    <input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(event) => setCurrentPassword(event.target.value)} />
                  </label>
                  <label className="family-model-settings-checkbox-field">
                    <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                    <span>我确认更换向量身份，并理解系统会完整重建搜索索引。</span>
                  </label>
                  <div className="family-model-settings-editor-actions">
                    <button className="ghost-button" type="button" disabled={busy} onClick={() => setPreview(null)}>返回修改</button>
                    <button className="family-model-settings-danger-action" type="button" disabled={busy || !currentPassword || !confirmed} onClick={() => { void startReplacement(); }}>{busy ? '正在开始' : '确认并开始重建'}</button>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <ConfirmDialog
        open={initialConfirmOpen}
        title="确认建立搜索索引"
        description={(
          <div className="family-model-settings-initial-confirm-copy">
            <p>确认后，系统会使用 <strong>{embedding.requested_model}</strong>（{embedding.dimensions} 维）为全部家庭内容建立搜索索引。</p>
            <p>今后更换向量模型、Provider 或维度时，需要完整重建搜索索引。首次建立完成前不会提供语义搜索。</p>
          </div>
        )}
        confirmLabel="确认并建立索引"
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

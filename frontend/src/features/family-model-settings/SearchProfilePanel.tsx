import { useMemo, useState } from 'react';
import type {
  FamilyModelBindingDraft,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelPriceRate,
  FamilyModelSearchReplacement,
  FamilyModelSearchReplacementPreviewResult,
} from '../../api/types/modelUsage';
import {
  ConfirmDialog,
  DropdownSelect,
  FormActions,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { safeFamilyModelSettingsError, type FamilyModelSettingsDraft } from './familyModelSettingsModel';
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
  const [replacementTest, setReplacementTest] = useState<{
    status: 'running' | 'succeeded' | 'blocked' | 'failed' | 'request-error';
    message: string;
  } | null>(null);
  const [dismissedReplacementId, setDismissedReplacementId] = useState<string | null>(null);
  const [startedReplacement, setStartedReplacement] = useState<FamilyModelSearchReplacement | null>(null);
  const [replacementLaunchPending, setReplacementLaunchPending] = useState(false);
  const embeddingProfiles = useMemo(
    () => props.settings.provider_profiles.filter((profile) => profileSupportsCapability(profile, 'embedding')),
    [props.settings.provider_profiles],
  );
  const workingDraft = useMemo(
    () => pendingEmbedding ? replaceBinding(props.draft, pendingEmbedding) : props.draft,
    [pendingEmbedding, props.draft],
  );
  const embedding = findEmbedding(workingDraft);
  const replacementActionBusy = props.busyAction !== null || replacementLaunchPending;
  const busy = replacementActionBusy || replacementTest?.status === 'running';
  const activeSearchProfileId = props.settings.active_search_profile_id ?? null;
  // The active pointer is authoritative after an asynchronous replacement.
  // The persisted form value is only a pending/initial hint and must not
  // overwrite the model currently used by runtime search.
  const configuredSearchProfileId = activeSearchProfileId ?? props.draft.search_profile_id;
  // Keep the response visible immediately after the mutation resolves. The
  // replacement query is intentionally refreshed in the background, so the
  // page should not go blank between the mutation response and that refresh.
  const replacement = startedReplacement
    && props.searchReplacement?.profile_id !== startedReplacement.profile_id
    ? startedReplacement
    : props.searchReplacement ?? startedReplacement;
  const replacementIsCandidate = Boolean(
    replacement
      && replacement.status !== 'active'
      && replacement.status !== 'cancelled'
      && replacement.profile_id !== activeSearchProfileId
      && replacement.profile_id !== dismissedReplacementId,
  );
  const rates = props.draft.price_rates.filter((rate) => rate.capability === 'embedding');
  const isInitialReady = !configuredSearchProfileId && embeddingReady(embedding);
  const activeEmbedding = activeSearchProfileId
    ? props.draft.active_embedding_binding ?? findEmbedding(props.draft)
    : null;
  const activeProvider = activeEmbedding?.provider_profile_id
    ? props.settings.provider_profiles.find((profile) => profile.id === activeEmbedding.provider_profile_id)
    : null;

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

  function closeReplacementEditor() {
    if (busy) return;
    setReplacementEditorOpen(false);
    setPreview(null);
    setCurrentPassword('');
    setConfirmed(false);
    setReplacementTest(null);
  }

  async function testReplacementModel() {
    if (!activeSearchProfileId || !providerProfileId || !requestedModel.trim()) return;
    setReplacementTest({ status: 'running', message: '正在等待模型响应。' });
    try {
      const result = await props.onTestCapability('embedding', 'search', true, {
        provider_profile_id: providerProfileId,
        requested_model: requestedModel.trim(),
        dimensions: Number(dimensions) || 0,
      });
      const resultStatus = result && typeof result === 'object' && 'status' in result
        ? result.status
        : 'failed';
      const resultDetail = result && typeof result === 'object' && 'detail' in result
        && typeof result.detail === 'string'
        ? result.detail
        : null;
      const status = resultStatus === 'succeeded'
        ? 'succeeded'
        : resultStatus === 'blocked'
          ? 'blocked'
          : 'failed';
      setReplacementTest({
        status,
        message: resultDetail || (status === 'succeeded'
          ? '测试成功，可以继续查看更新范围。'
          : status === 'blocked'
            ? '测试被用量限制阻止，未请求模型。'
            : '模型测试未通过，请检查服务、模型和维度。'),
      });
    } catch (reason) {
      setReplacementTest({
        status: 'request-error',
        message: safeFamilyModelSettingsError(reason),
      });
    }
  }

  async function startReplacement() {
    if (!preview || replacementLaunchPending) return;
    // Keep the confirmation form mounted while the request is in flight. If
    // the server rejects the request (password/version/checksum), closing it
    // optimistically and reopening from catch produces a visible flash and
    // makes the failure look like an unexplained state reset.
    setReplacementLaunchPending(true);
    try {
      const result = await props.actions.createSearchReplacement({
        ...baseInput(),
        confirm_checksum: preview.confirmation_checksum,
        current_password: currentPassword,
      });
      setStartedReplacement(result);
      props.onReplacementProfileIdChange(result.profile_id);
      setCurrentPassword('');
      setConfirmed(false);
      setReplacementTest(null);
      setReplacementEditorOpen(false);
      setPreview(null);
    } catch {
      // Keep the form and entered values in place; the workspace exposes the
      // server error and the user can correct/retry without a visual reset.
    } finally {
      setReplacementLaunchPending(false);
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
    const replacementId = replacement.profile_id;
    setStartedReplacement((current) => current?.profile_id === replacementId ? null : current);
    setDismissedReplacementId(replacementId);
    props.onReplacementProfileIdChange(null);
    try {
      await props.actions.cancelSearchReplacement(replacementId, {
        base_settings_version_number: props.settings.version_number,
      });
    } catch {
      // Preserve the operation state until the server settles it.
      setDismissedReplacementId(null);
      props.onReplacementProfileIdChange(replacementId);
    }
  }

  return (
    <section className="family-model-settings-editor family-model-settings-search-editor" aria-labelledby="family-model-search-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-search-title">智能搜索</h2>
          <p>首次启用或更换模型时，系统会先准备搜索数据；已有搜索在完成前保持可用。</p>
        </div>
      </div>

      <div className={`family-model-settings-search-state-strip ${activeSearchProfileId ? 'is-ready' : 'is-pending'}`} role="status" aria-live="polite">
        <span className="family-model-settings-search-state-icon" aria-hidden="true">{activeSearchProfileId ? '✓' : '!'}</span>
        <div>
          <strong>{activeSearchProfileId ? '当前搜索已生效' : '搜索尚未启用'}</strong>
          <span>{activeSearchProfileId
            ? `实际使用 ${activeProvider?.display_name ?? '当前服务'} / ${activeEmbedding?.requested_model || '未填写模型'} / ${activeEmbedding?.dimensions || '—'} 维`
            : replacementIsCandidate && replacement?.status === 'failed'
              ? '新的搜索配置尚未启用，可重试或返回重新配置。'
              : configuredSearchProfileId
                ? '新的搜索配置正在准备中，完成后才会启用。'
                : '配置并确认搜索模型后，系统才会为家庭内容建立智能搜索。'}</span>
        </div>
      </div>

      {replacementLaunchPending ? (
        <section
          className="family-model-settings-search-progress is-launching"
          aria-live="polite"
          aria-busy="true"
          role="status"
          aria-label="搜索更新启动状态"
        >
          <div>
            <h3>更新任务正在启动</h3>
            <p>请求已提交，系统正在创建更新任务。当前搜索仍可继续使用，请勿重复操作。</p>
          </div>
          <strong>
            <span className="family-model-settings-search-launch-spinner" aria-hidden="true" />
            预计更新 {preview?.document_count ?? 0} 项
          </strong>
        </section>
      ) : null}

      {!replacementLaunchPending && replacement && replacementIsCandidate ? (
        <section className="family-model-settings-search-progress" aria-live="polite">
          <div>
            <h3>{activeSearchProfileId ? '智能搜索更新进度' : '首次启用智能搜索'}</h3>
            <p>{replacement.status === 'provisioning' ? '正在更新家庭内容的搜索数据，可继续使用当前搜索。' : '搜索数据更新失败，现有搜索没有被替换。'}</p>
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

      {activeSearchProfileId ? (
        <>
          <section className="family-model-settings-search-current" aria-labelledby="family-model-search-current-title">
            <div className="family-model-settings-search-section-head">
              <div>
                <span className="family-model-settings-search-eyebrow">当前配置</span>
                <h3 id="family-model-search-current-title">当前生效模型</h3>
                <p>这组配置正在为家庭内容提供智能搜索。</p>
              </div>
              <span className="family-model-settings-search-active-badge">正在使用</span>
            </div>
            <div className="family-model-settings-search-current-grid">
              <div><span>模型服务</span><strong>{activeProvider?.display_name ?? '当前服务'}</strong></div>
              <div><span>模型名称</span><strong>{activeEmbedding?.requested_model || '未填写'}</strong></div>
              <div><span>模型维度</span><strong>{activeEmbedding?.dimensions || '—'}</strong></div>
            </div>
            <div className="family-model-settings-search-current-foot">
              <span>更换模型后会重新生成全部搜索数据，完成前仍使用当前配置。</span>
              <button
                className="family-model-settings-search-replace-cta"
                type="button"
                aria-expanded={replacementEditorOpen}
                aria-controls="family-model-settings-search-replace"
                disabled={busy || replacementIsCandidate}
                onClick={() => setReplacementEditorOpen(true)}
              >
                更换搜索模型
              </button>
            </div>
          </section>
          {replacementIsCandidate && replacement && preview ? (
            <section className="family-model-settings-search-replacing" aria-labelledby="family-model-search-replacing-title">
              <div className="family-model-settings-search-section-head">
                <div>
                  <span className="family-model-settings-search-eyebrow">替换中</span>
                  <h3 id="family-model-search-replacing-title">正在准备的新模型</h3>
                  <p>搜索数据生成完成后会自动切换；在此之前仍使用当前生效模型。</p>
                </div>
                <span className="family-model-settings-search-replacing-badge">即将生效</span>
              </div>
              <div className="family-model-settings-search-current-grid">
                <div><span>模型服务</span><strong>{props.settings.provider_profiles.find((profile) => profile.id === providerProfileId)?.display_name ?? '当前服务'}</strong></div>
                <div><span>模型名称</span><strong>{requestedModel}</strong></div>
                <div><span>模型维度</span><strong>{dimensions} 维</strong></div>
              </div>
              <div className="family-model-settings-search-replacing-progress" role="status">
                <span className="family-model-settings-search-replacing-dot" aria-hidden="true" />
                <span>已准备替换任务，正在生成 {replacement.indexed_documents} / {replacement.total_documents} 项搜索数据</span>
              </div>
            </section>
          ) : null}
          <section className="family-model-settings-search-sort" aria-labelledby="family-model-search-sort-title">
            <div className="family-model-settings-search-section-head">
              <div>
                <span className="family-model-settings-search-eyebrow">可选配置</span>
                <h3 id="family-model-search-sort-title">搜索排序</h3>
                <p>只影响结果展示顺序，不会触发向量重建。</p>
              </div>
            </div>
            <CapabilityBindingEditor
              draft={workingDraft}
              profiles={props.settings.provider_profiles}
              busy={busy}
              scope="search"
              onlyCapabilities={['rerank']}
              embedded
              onDraftChange={handleSearchDraftChange}
              onDiscoverModels={props.onDiscoverModels}
              onTestCapability={props.onTestCapability}
            />
          </section>
        </>
      ) : (
        <section className="family-model-settings-search-capabilities" aria-labelledby="family-model-search-capabilities-title">
          <div className="family-model-settings-search-section-head">
            <div>
              <span className="family-model-settings-search-eyebrow">开始配置</span>
              <h3 id="family-model-search-capabilities-title">搜索模型</h3>
              <p>先配置一个模型，确认后才会建立家庭搜索数据。</p>
            </div>
          </div>
          <CapabilityBindingEditor
            draft={workingDraft}
            profiles={props.settings.provider_profiles}
            busy={busy}
            scope="search"
            embedded
            blockedTests={['embedding']}
            onDraftChange={handleSearchDraftChange}
            onDiscoverModels={props.onDiscoverModels}
            onTestCapability={props.onTestCapability}
          />
          <div className="family-model-settings-initial-search-action">
            <div>
              <strong>准备好后确认开启</strong>
              <span>确认后会保存模型设置并开始建立搜索数据。</span>
            </div>
            <button className="solid-button" type="button" disabled={busy || !isInitialReady} onClick={() => setInitialConfirmOpen(true)}>
              确认搜索模型
            </button>
          </div>
        </section>
      )}

      {activeSearchProfileId && replacementEditorOpen ? (
        <WorkspaceOverlayFrame
          rootClassName="family-model-settings-replacement-overlay-root"
          busy={busy}
          onClose={closeReplacementEditor}
        >
          <WorkspaceModal
            eyebrow="高影响操作"
            title="更换搜索模型"
            description="选择新的服务、模型和维度。系统会先估算影响范围，确认后再开始更新。"
            className="family-model-settings-replacement-modal"
            busy={busy}
            onClose={closeReplacementEditor}
            footerActions={(
              <FormActions
                primaryLabel={preview ? '确认并开始更新' : '查看更新范围'}
                primaryTone="danger"
                primaryDisabled={busy || (preview
                  ? !currentPassword || !confirmed
                  : !providerProfileId || !requestedModel.trim() || rates.length === 0)}
                isSubmitting={replacementActionBusy}
                submittingLabel={preview ? '正在开始' : '正在估算'}
                secondaryLabel={preview ? '返回修改' : '取消'}
                onPrimary={() => { if (preview) void startReplacement(); else void previewReplacement(); }}
                onSecondary={() => { if (busy) return; if (preview) setPreview(null); else closeReplacementEditor(); }}
              />
            )}
          >
            <div id="family-model-settings-search-replace" className="family-model-settings-replacement-modal-body">
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
                      onChange={(value) => { setProviderProfileId(value); setPreview(null); setReplacementTest(null); }}
                    />
                  </div>
                  <label className="family-model-settings-field">
                    <span>新的搜索模型</span>
                    <input value={requestedModel} disabled={busy} onChange={(event) => { setRequestedModel(event.target.value); setPreview(null); setReplacementTest(null); }} placeholder="输入模型名称" />
                  </label>
                  <label className="family-model-settings-field">
                    <span>模型维度</span>
                    <input type="number" min="1" value={dimensions} disabled={busy} onChange={(event) => { setDimensions(event.target.value); setPreview(null); setReplacementTest(null); }} />
                  </label>
                </div>
                <div className={`family-model-settings-replacement-test ${replacementTest ? `is-${replacementTest.status}` : ''}`}>
                  <button
                    className={`ghost-button family-model-settings-test-button ${replacementTest ? `is-${replacementTest.status}` : ''}`}
                    type="button"
                    disabled={busy || !providerProfileId || !requestedModel.trim() || Number(dimensions) <= 0}
                    aria-busy={replacementTest?.status === 'running'}
                    onClick={() => { void testReplacementModel(); }}
                  >
                    {replacementTest?.status === 'running' ? <span className="family-model-settings-test-spinner" aria-hidden="true" /> : null}
                    {replacementTest?.status === 'running'
                      ? '正在测试'
                      : replacementTest?.status === 'succeeded'
                        ? '测试成功'
                        : replacementTest?.status
                        ? '重新测试'
                          : '测试模型'}
                  </button>
                  {replacementTest && replacementTest.status !== 'running' && replacementTest.status !== 'succeeded' ? (
                    <span className="family-model-settings-replacement-test-error" role="alert">
                      {replacementTest.message}
                    </span>
                  ) : null}
                </div>
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
                </section>
              ) : null}
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
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

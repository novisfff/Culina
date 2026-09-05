import { useCallback, useEffect, useRef, useState } from 'react';
import { ComboboxField, DropdownSelect } from '../../components/ui-kit';
import type {
  FamilyModelBindingDraft,
  FamilyModelCapability,
  FamilyModelProviderConnectionCheckResult,
  FamilyModelProviderProfile,
} from '../../api/types/modelUsage';
import { safeFamilyModelSettingsError, type FamilyModelSettingsDraft } from './familyModelSettingsModel';
import {
  FAMILY_MODEL_CAPABILITY_OPTIONS,
  FAMILY_MODEL_ADAPTER_OPTIONS,
  profileSupportsCapability,
} from './familyModelSettingsOptions';

export type CapabilityBindingEditorProps = {
  draft: FamilyModelSettingsDraft;
  profiles: FamilyModelProviderProfile[];
  busy: boolean;
  onDraftChange: (draft: FamilyModelSettingsDraft) => void;
  onDiscoverModels: (profileId: string) => Promise<FamilyModelProviderConnectionCheckResult>;
  onTestCapability: (capability: FamilyModelCapability, variantKey: string, confirmBillable: boolean) => Promise<unknown>;
  scope?: 'general' | 'search';
  embedded?: boolean;
  blockedTests?: readonly FamilyModelCapability[];
  onlyCapabilities?: readonly FamilyModelCapability[];
};

type ModelDiscoveryState =
  | { status: 'loading'; models: string[] }
  | { status: 'ready'; models: string[] }
  | { status: 'not_supported'; models: string[] }
  | { status: 'error'; models: string[] };

type CapabilityTestState = {
  status: 'running' | 'succeeded' | 'blocked' | 'failed' | 'request-error';
  message: string;
};

const CAPABILITY_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  capabilities: readonly FamilyModelCapability[];
}> = [
  { id: 'generation', label: '对话与生成', description: '对话理解、图片理解与图片生成。', capabilities: ['llm', 'image_generation'] },
  { id: 'voice', label: '语音', description: '语音识别、播报与实时语音。', capabilities: ['stt', 'tts', 'realtime_audio'] },
  { id: 'search', label: '搜索', description: '家庭内容的智能搜索与结果排序。', capabilities: ['embedding', 'rerank'] },
];

const IMAGE_SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024 × 1024', description: '方形图片' },
  { value: '1024x1536', label: '1024 × 1536', description: '竖版图片' },
  { value: '1536x1024', label: '1536 × 1024', description: '横版图片' },
] as const;

const RESPONSE_FORMAT_OPTIONS = [
  { value: 'b64_json', label: '内联图片', description: '直接返回图片内容，适合安全存储。' },
  { value: 'url', label: '图片链接', description: '由模型服务返回图片链接。' },
] as const;

function bindingKey(binding: FamilyModelBindingDraft): string {
  return `${binding.capability}:${binding.variant_key}`;
}

function bindingTitle(binding: FamilyModelBindingDraft): string {
  const suffix = binding.variant_key === 'primary'
    ? '主用'
    : binding.variant_key === 'fallback'
      ? '备用'
      : binding.variant_key === 'reference'
        ? '参考图'
        : binding.variant_key === 'text'
          ? '文字生成'
          : '默认';
  return `${FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].label} · ${suffix}`;
}

function bindingCanRunDraftTest(binding: FamilyModelBindingDraft): boolean {
  return binding.enabled
    && Boolean(binding.provider_profile_id)
    && binding.requested_model.trim().length > 0;
}

function isActiveEmbedding(draft: FamilyModelSettingsDraft, binding: FamilyModelBindingDraft): boolean {
  return binding.capability === 'embedding'
    && binding.variant_key === 'search'
    && Boolean(draft.active_embedding_binding);
}

function getCapabilityIcon(capability: FamilyModelCapability) {
  switch (capability) {
    case 'llm':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9L12 3Z" />
        </svg>
      );
    case 'image_generation':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      );
    case 'stt':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8" />
        </svg>
      );
    case 'tts':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      );
    case 'realtime_audio':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4" />
        </svg>
      );
    case 'embedding':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4.5 4.5" />
          <path d="M8 11h6" />
        </svg>
      );
    case 'rerank':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="14" y2="12" />
          <line x1="4" y1="18" x2="8" y2="18" />
        </svg>
      );
  }
}

export function CapabilityBindingEditor(props: CapabilityBindingEditorProps) {
  const allowedCapabilities = props.onlyCapabilities ? new Set(props.onlyCapabilities) : null;
  const visibleGroups = CAPABILITY_GROUPS.filter((group) => {
    const inScope = props.scope === 'search' ? group.id === 'search' : group.id !== 'search';
    return inScope && (!allowedCapabilities || group.capabilities.some((capability) => allowedCapabilities.has(capability)));
  });
  const visibleCapabilities = new Set(
    visibleGroups.flatMap((group) => group.capabilities).filter((capability) => !allowedCapabilities || allowedCapabilities.has(capability)),
  );
  const [capabilityTests, setCapabilityTests] = useState<Record<string, CapabilityTestState>>({});
  const [selectedBindingKey, setSelectedBindingKey] = useState(() => {
    const visibleBindings = props.draft.bindings.filter((binding) => visibleCapabilities.has(binding.capability));
    const first = props.scope === 'search' && props.draft.active_embedding_binding
      ? visibleBindings.find((binding) => binding.capability === 'embedding')
      : visibleBindings.find((binding) => binding.enabled) ?? visibleBindings[0];
    return first ? bindingKey(first) : '';
  });
  const [modelDiscovery, setModelDiscovery] = useState<Record<string, ModelDiscoveryState>>({});
  const modelDiscoveryInFlight = useRef(new Set<string>());

  const discoverModels = useCallback(async (profileId: string) => {
    if (modelDiscoveryInFlight.current.has(profileId)) return;
    modelDiscoveryInFlight.current.add(profileId);
    setModelDiscovery((current) => ({
      ...current,
      [profileId]: { status: 'loading', models: current[profileId]?.models ?? [] },
    }));
    try {
      const result = await props.onDiscoverModels(profileId);
      setModelDiscovery((current) => ({
        ...current,
        [profileId]: {
          status: result.status === 'not_supported' ? 'not_supported' : 'ready',
          models: result.models,
        },
      }));
    } catch {
      setModelDiscovery((current) => ({
        ...current,
        [profileId]: { status: 'error', models: current[profileId]?.models ?? [] },
      }));
    } finally {
      modelDiscoveryInFlight.current.delete(profileId);
    }
  }, [props.onDiscoverModels]);

  const selectedBinding = props.draft.bindings.find((binding) => bindingKey(binding) === selectedBindingKey);
  const selectedProfileId = selectedBinding?.provider_profile_id ?? null;

  useEffect(() => {
    if (!selectedProfileId || modelDiscovery[selectedProfileId]) return;
    void discoverModels(selectedProfileId);
  }, [discoverModels, modelDiscovery, selectedProfileId]);

  function replaceBinding(index: number, next: FamilyModelBindingDraft) {
    const previous = props.draft.bindings[index];
    if (previous) {
      const previousKey = bindingKey(previous);
      setCapabilityTests((current) => {
        if (!current[previousKey]) return current;
        const updated = { ...current };
        delete updated[previousKey];
        return updated;
      });
    }
    const bindings = props.draft.bindings.map((binding, candidateIndex) => candidateIndex === index ? next : binding);
    props.onDraftChange({ ...props.draft, bindings });
  }

  function patchBinding(index: number, binding: FamilyModelBindingDraft, patch: Partial<FamilyModelBindingDraft>) {
    replaceBinding(index, { ...binding, ...patch } as FamilyModelBindingDraft);
  }

  async function runCapabilityTest(binding: FamilyModelBindingDraft) {
    const key = `${binding.capability}:${binding.variant_key}`;
    setCapabilityTests((current) => ({
      ...current,
      [key]: { status: 'running', message: '正在等待模型响应。' },
    }));
    try {
      const result = await props.onTestCapability(binding.capability, binding.variant_key, true);
      const resultStatus = result && typeof result === 'object' && 'status' in result
        ? result.status
        : 'failed';
      const resultDetail = result && typeof result === 'object' && 'detail' in result
        && typeof result.detail === 'string'
        ? result.detail
        : null;
      const nextState: CapabilityTestState = resultStatus === 'succeeded'
        ? { status: 'succeeded', message: resultDetail || '测试成功，点击可再次测试。' }
        : resultStatus === 'blocked'
          ? { status: 'blocked', message: resultDetail || '测试被用量限制阻止，未请求模型。请检查模型用量限制后重试。' }
          : { status: 'failed', message: resultDetail || '服务未通过功能测试，请检查模型服务、模型和价格配置后重试。' };
      setCapabilityTests((current) => ({
        ...current,
        [key]: nextState,
      }));
    } catch (reason) {
      setCapabilityTests((current) => ({
        ...current,
        [key]: { status: 'request-error', message: safeFamilyModelSettingsError(reason) },
      }));
    }
  }

  const bindingGroups = (
    <div className="family-model-settings-binding-groups">
      {visibleGroups.map((group) => (
        <section key={group.id} className="family-model-settings-binding-group" aria-labelledby={`family-model-settings-binding-group-${group.id}`}>
          {!props.embedded ? (
            <div className="family-model-settings-group-head">
              <div>
                <h3 id={`family-model-settings-binding-group-${group.id}`}>{group.label}</h3>
                <p>{group.description}</p>
              </div>
              <span>{props.draft.bindings.filter((binding) => group.capabilities.includes(binding.capability) && binding.enabled).length} 项启用</span>
            </div>
          ) : null}
          <div className="family-model-settings-binding-list">
            {props.draft.bindings.map((binding, index) => ({ binding, index })).filter(({ binding }) => group.capabilities.includes(binding.capability) && (!allowedCapabilities || allowedCapabilities.has(binding.capability))).map(({ binding, index }) => {
              const key = bindingKey(binding);
              const embeddingLocked = isActiveEmbedding(props.draft, binding);
              const profiles = props.profiles.filter((profile) => profileSupportsCapability(profile, binding.capability));
              const expanded = selectedBindingKey === key;
              const capabilityTest = capabilityTests[key];
              const testBlocked = props.blockedTests?.includes(binding.capability) ?? false;
              const canRunDraftTest = bindingCanRunDraftTest(binding) && !testBlocked && !embeddingLocked;
              return (
                <article key={key} className={`family-model-settings-binding-card ${expanded ? 'is-expanded' : ''}`}>
                  <div className="family-model-settings-binding-head">
                    <button type="button" aria-expanded={expanded} aria-controls={`family-model-settings-binding-panel-${key}`} onClick={() => setSelectedBindingKey(key)}>
                      <div className="family-model-settings-binding-head-info">
                        <span className={`family-model-settings-binding-icon tone-${binding.capability}`} aria-hidden="true">
                          {getCapabilityIcon(binding.capability)}
                        </span>
                        <div>
                          <h3>{bindingTitle(binding)}</h3>
                          <p>{FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].description}</p>
                        </div>
                      </div>
                      <span className={`family-model-settings-binding-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <label className="family-model-settings-switch">
                      <input
                        type="checkbox"
                        checked={binding.enabled}
                        disabled={props.busy || embeddingLocked}
                        onChange={(event) => patchBinding(index, binding, { enabled: event.target.checked })}
                      />
                      <span className="family-model-settings-switch-track" aria-hidden="true" />
                      <span>{binding.enabled ? '已启用' : '未启用'}</span>
                    </label>
                  </div>
                  {expanded ? <div id={`family-model-settings-binding-panel-${key}`} className="family-model-settings-binding-panel">
                  {embeddingLocked ? <p className="family-model-settings-readonly-note">搜索设置已生效。更换模型服务、模型或维度时，需要重新生成搜索数据。</p> : null}
                  <div className="family-model-settings-form-grid">
                    <div className="family-model-settings-field">
                      <span>模型服务</span>
                      <DropdownSelect
                        ariaLabel="模型服务选项"
                        triggerAriaLabel="模型服务"
                        placeholder="选择兼容服务"
                        value={binding.provider_profile_id ?? ''}
                        options={profiles.map((profile) => ({
                          value: profile.id,
                          label: profile.display_name,
                          description: FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === profile.adapter_kind)?.label
                            ?? profile.adapter_kind,
                        }))}
                        clearOption={{
                          value: '',
                          label: '选择兼容服务',
                          description: '先选择服务，再自动读取可用模型。',
                        }}
                        disabled={props.busy || embeddingLocked}
                        className="family-model-settings-dropdown"
                        onChange={(value) => patchBinding(index, binding, { provider_profile_id: value || null })}
                      />
                    </div>
                    <div className="family-model-settings-field">
                      <span>模型名称</span>
                      <ComboboxField
                        ariaLabel="模型名称"
                        value={binding.requested_model}
                        options={(binding.provider_profile_id ? modelDiscovery[binding.provider_profile_id]?.models ?? [] : [])
                          .map((model) => ({ value: model, label: model }))}
                        allowCustom
                        disabled={props.busy || embeddingLocked}
                        placeholder={binding.provider_profile_id ? '选择或输入模型名称' : '请先选择模型服务'}
                        onChange={(value) => patchBinding(index, binding, { requested_model: String(value) })}
                      />
                      {binding.provider_profile_id ? (
                        <div
                          className={`family-model-settings-model-discovery is-${modelDiscovery[binding.provider_profile_id]?.status ?? 'loading'}`}
                          role="status"
                        >
                          <span>
                            {modelDiscovery[binding.provider_profile_id]?.status === 'ready'
                              ? modelDiscovery[binding.provider_profile_id].models.length > 0
                                ? `已自动读取 ${modelDiscovery[binding.provider_profile_id].models.length} 个模型，也可以直接输入其他模型名称。`
                                : '服务连接正常，但未返回模型列表，请手动输入模型名称。'
                              : modelDiscovery[binding.provider_profile_id]?.status === 'not_supported'
                                ? '此服务不支持自动读取模型列表，请手动输入模型名称。'
                                : modelDiscovery[binding.provider_profile_id]?.status === 'error'
                                  ? '自动读取模型列表失败，仍可手动输入。'
                                  : '正在自动读取模型列表…'}
                          </span>
                          {modelDiscovery[binding.provider_profile_id]?.status === 'error' ? (
                            <button
                              type="button"
                              className="tertiary-button"
                              disabled={props.busy}
                              onClick={() => { void discoverModels(binding.provider_profile_id as string); }}
                            >
                              重新读取
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="family-model-settings-model-discovery" role="status">
                          <span>选择服务后会自动读取模型列表，也可以直接手动输入。</span>
                        </div>
                      )}
                    </div>
                    {binding.capability === 'llm' ? (
                      <>
                        <label className="family-model-settings-field">
                          <span>最大回复长度（Token）</span>
                          <input type="number" min="1" value={binding.max_output_tokens} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { max_output_tokens: Number(event.target.value) || 1 })} />
                        </label>
                        <div className="family-model-settings-field">
                          <span>图片理解</span>
                          <label className="family-model-settings-toggle-card">
                            <input type="checkbox" checked={binding.supports_vision} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { supports_vision: event.target.checked })} />
                            <span className="family-model-settings-switch-track" aria-hidden="true" />
                            <span className="family-model-settings-toggle-card-copy">
                              <strong>支持图片理解</strong>
                              <small>允许识别菜谱照片与食材图片</small>
                            </span>
                          </label>
                        </div>
                      </>
                    ) : null}
                    {binding.capability === 'image_generation' ? (
                      <>
                        <div className="family-model-settings-field">
                          <span>图片尺寸</span>
                          <DropdownSelect
                            ariaLabel="图片尺寸选项"
                            triggerAriaLabel="图片尺寸"
                            placeholder="选择图片尺寸"
                            value={binding.image_size}
                            options={IMAGE_SIZE_OPTIONS}
                            disabled={props.busy}
                            className="family-model-settings-dropdown"
                            onChange={(value) => { if (value) patchBinding(index, binding, { image_size: value }); }}
                          />
                        </div>
                        <div className="family-model-settings-field">
                          <span>返回格式</span>
                          <DropdownSelect
                            ariaLabel="返回格式选项"
                            triggerAriaLabel="返回格式"
                            placeholder="选择返回格式"
                            value={binding.response_format}
                            options={RESPONSE_FORMAT_OPTIONS}
                            disabled={props.busy}
                            className="family-model-settings-dropdown"
                            onChange={(value) => { if (value) patchBinding(index, binding, { response_format: value }); }}
                          />
                        </div>
                      </>
                    ) : null}
                    {binding.capability === 'embedding' ? (
                      <label className="family-model-settings-field">
                        <span>模型维度</span>
                        <input type="number" min="1" value={binding.dimensions} disabled={props.busy || embeddingLocked} onChange={(event) => patchBinding(index, binding, { dimensions: Number(event.target.value) || 1 })} />
                      </label>
                    ) : null}
                    {binding.capability === 'rerank' ? (
                      <label className="family-model-settings-field">
                        <span>返回条数</span>
                        <input type="number" min="1" max="200" value={binding.top_n} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { top_n: Number(event.target.value) || 1 })} />
                      </label>
                    ) : null}
                  </div>
                  <div className="family-model-settings-binding-test">
                    {capabilityTest && capabilityTest.status !== 'running' && capabilityTest.status !== 'succeeded' ? (
                      <span className="family-model-settings-test-detail" role="status" aria-label="能力测试状态">
                        {capabilityTest.message}
                      </span>
                    ) : null}
                    <button
                      className={`ghost-button family-model-settings-test-button ${capabilityTest ? `is-${capabilityTest.status}` : ''}`}
                      type="button"
                      title={testBlocked
                        ? '请先确认搜索模型并开启智能搜索。'
                        : embeddingLocked
                          ? '当前搜索模型已生效，请在“智能搜索”中通过更换模型流程测试候选配置。'
                        : !canRunDraftTest
                          ? '请先启用功能，并补全模型服务和模型名称。'
                          : capabilityTest?.message}
                      aria-busy={capabilityTest?.status === 'running'}
                      disabled={props.busy || !canRunDraftTest || capabilityTest?.status === 'running'}
                      onClick={() => { void runCapabilityTest(binding); }}
                    >
                      {capabilityTest?.status === 'running' ? (
                        <span className="family-model-settings-test-spinner" aria-hidden="true" />
                      ) : null}
                      {capabilityTest?.status === 'succeeded' ? (
                        <svg className="family-model-settings-test-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m5 12 4 4 10-10" />
                        </svg>
                      ) : null}
                      {capabilityTest?.status === 'running'
                        ? '正在测试'
                        : capabilityTest?.status === 'succeeded'
                          ? '测试成功'
                          : capabilityTest?.status === 'blocked'
                            ? '用量受限，重试'
                            : capabilityTest?.status === 'failed' || capabilityTest?.status === 'request-error'
                              ? '测试失败，重试'
                              : '测试功能'}
                    </button>
                  </div>
                  </div> : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );

  if (props.embedded) return bindingGroups;

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-capability-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-capability-editor-title">功能设置</h2>
          <p>为对话、图片和语音功能选择兼容服务与模型；搜索相关设置统一在“智能搜索”中管理。</p>
        </div>
      </div>
      {bindingGroups}
    </section>
  );
}

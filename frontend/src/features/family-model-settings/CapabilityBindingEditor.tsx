import { useState } from 'react';
import type {
  FamilyModelBindingDraft,
  FamilyModelCapability,
  FamilyModelProviderProfile,
} from '../../api/types';
import type { FamilyModelSettingsDraft } from './familyModelSettingsModel';
import {
  FAMILY_MODEL_CAPABILITY_OPTIONS,
  profileSupportsCapability,
} from './familyModelSettingsOptions';

export type CapabilityBindingEditorProps = {
  draft: FamilyModelSettingsDraft;
  profiles: FamilyModelProviderProfile[];
  busy: boolean;
  onDraftChange: (draft: FamilyModelSettingsDraft) => void;
  onTestCapability: (capability: FamilyModelCapability, variantKey: string, confirmBillable: boolean) => Promise<unknown>;
};

const CAPABILITY_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  capabilities: readonly FamilyModelCapability[];
}> = [
  { id: 'generation', label: '对话与生成', description: '对话理解、图片理解与图片生成。', capabilities: ['llm', 'image_generation'] },
  { id: 'voice', label: '语音', description: '语音识别、播报与实时语音。', capabilities: ['stt', 'tts', 'realtime_audio'] },
  { id: 'search', label: '搜索', description: '家庭内容的向量检索与结果重排。', capabilities: ['embedding', 'rerank'] },
];

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

function isActiveEmbedding(draft: FamilyModelSettingsDraft, binding: FamilyModelBindingDraft): boolean {
  return binding.capability === 'embedding'
    && binding.variant_key === 'search'
    && Boolean(draft.active_embedding_binding);
}

export function CapabilityBindingEditor(props: CapabilityBindingEditorProps) {
  const [confirmedTests, setConfirmedTests] = useState<Record<string, boolean>>({});
  const [testMessage, setTestMessage] = useState<Record<string, string>>({});
  const [selectedBindingKey, setSelectedBindingKey] = useState(() => {
    const first = props.draft.active_embedding_binding
      ? props.draft.bindings.find((binding) => binding.capability === 'embedding')
      : props.draft.bindings.find((binding) => binding.enabled) ?? props.draft.bindings[0];
    return first ? bindingKey(first) : '';
  });

  function replaceBinding(index: number, next: FamilyModelBindingDraft) {
    const bindings = props.draft.bindings.map((binding, candidateIndex) => candidateIndex === index ? next : binding);
    props.onDraftChange({ ...props.draft, bindings });
  }

  function patchBinding(index: number, binding: FamilyModelBindingDraft, patch: Partial<FamilyModelBindingDraft>) {
    replaceBinding(index, { ...binding, ...patch } as FamilyModelBindingDraft);
  }

  async function runCapabilityTest(binding: FamilyModelBindingDraft) {
    const key = `${binding.capability}:${binding.variant_key}`;
    try {
      const result = await props.onTestCapability(binding.capability, binding.variant_key, confirmedTests[key] === true);
      setTestMessage((current) => ({
        ...current,
        [key]: result && typeof result === 'object' && 'status' in result && result.status === 'succeeded'
          ? '真实能力测试已完成。'
          : '测试没有完成，请检查配置。',
      }));
    } catch {
      // A workspace-level safe error remains visible without echoing provider detail.
    }
  }

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-capability-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-capability-editor-title">能力配置</h2>
          <p>为七类能力选择已创建的兼容服务档案和模型；启用后需要补全对应价格。</p>
        </div>
      </div>
      <div className="family-model-settings-binding-groups">
        {CAPABILITY_GROUPS.map((group) => (
          <section key={group.id} className="family-model-settings-binding-group" aria-labelledby={`family-model-settings-binding-group-${group.id}`}>
            <div className="family-model-settings-group-head">
              <div>
                <h3 id={`family-model-settings-binding-group-${group.id}`}>{group.label}</h3>
                <p>{group.description}</p>
              </div>
              <span>{props.draft.bindings.filter((binding) => group.capabilities.includes(binding.capability) && binding.enabled).length} 项启用</span>
            </div>
            <div className="family-model-settings-binding-list">
              {props.draft.bindings.map((binding, index) => ({ binding, index })).filter(({ binding }) => group.capabilities.includes(binding.capability)).map(({ binding, index }) => {
          const key = bindingKey(binding);
          const embeddingLocked = isActiveEmbedding(props.draft, binding);
          const profiles = props.profiles.filter((profile) => profileSupportsCapability(profile, binding.capability));
          const expanded = selectedBindingKey === key;
          return (
            <article key={key} className={`family-model-settings-binding-card ${expanded ? 'is-expanded' : ''}`}>
              <div className="family-model-settings-binding-head">
                <button type="button" aria-expanded={expanded} aria-controls={`family-model-settings-binding-panel-${key}`} onClick={() => setSelectedBindingKey(key)}>
                  <h3>{bindingTitle(binding)}</h3>
                  <p>{FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].description}</p>
                </button>
                <label className="family-model-settings-switch">
                  <input
                    type="checkbox"
                    checked={binding.enabled}
                    disabled={props.busy || embeddingLocked}
                    onChange={(event) => patchBinding(index, binding, { enabled: event.target.checked })}
                  />
                  <span>{binding.enabled ? '已启用' : '未启用'}</span>
                </label>
              </div>
              {expanded ? <div id={`family-model-settings-binding-panel-${key}`} className="family-model-settings-binding-panel">
              {embeddingLocked ? <p className="family-model-settings-readonly-note">更换这些设置需要完整重建搜索索引。</p> : null}
              <div className="family-model-settings-form-grid">
                <label className="family-model-settings-field">
                  <span>Provider 档案</span>
                  <select
                    value={binding.provider_profile_id ?? ''}
                    disabled={props.busy || embeddingLocked}
                    onChange={(event) => patchBinding(index, binding, { provider_profile_id: event.target.value || null })}
                  >
                    <option value="">选择兼容档案</option>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
                  </select>
                </label>
                <label className="family-model-settings-field">
                  <span>模型名称</span>
                  <input
                    value={binding.requested_model}
                    disabled={props.busy || embeddingLocked}
                    placeholder="输入服务商模型标识"
                    onChange={(event) => patchBinding(index, binding, { requested_model: event.target.value })}
                  />
                </label>
                {binding.capability === 'llm' ? (
                  <>
                    <label className="family-model-settings-field">
                      <span>最大输出 Token</span>
                      <input type="number" min="1" value={binding.max_output_tokens} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { max_output_tokens: Number(event.target.value) || 1 })} />
                    </label>
                    <label className="family-model-settings-checkbox-field">
                      <input type="checkbox" checked={binding.supports_vision} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { supports_vision: event.target.checked })} />
                      <span>支持图片理解</span>
                    </label>
                  </>
                ) : null}
                {binding.capability === 'image_generation' ? (
                  <>
                    <label className="family-model-settings-field">
                      <span>图片尺寸</span>
                      <select value={binding.image_size} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { image_size: event.target.value as typeof binding.image_size })}>
                        <option value="1024x1024">1024 × 1024</option>
                        <option value="1024x1536">1024 × 1536</option>
                        <option value="1536x1024">1536 × 1024</option>
                      </select>
                    </label>
                    <label className="family-model-settings-field">
                      <span>返回格式</span>
                      <select value={binding.response_format} disabled={props.busy} onChange={(event) => patchBinding(index, binding, { response_format: event.target.value as typeof binding.response_format })}>
                        <option value="b64_json">内联图片</option>
                        <option value="url">服务地址</option>
                      </select>
                    </label>
                  </>
                ) : null}
                {binding.capability === 'embedding' ? (
                  <label className="family-model-settings-field">
                    <span>向量维度</span>
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
                <label className="family-model-settings-checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmedTests[key] === true}
                    disabled={props.busy || !binding.enabled}
                    onChange={(event) => setConfirmedTests((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  <span>我确认本次测试可能产生费用</span>
                </label>
                <button className="ghost-button" type="button" disabled={props.busy || !binding.enabled || !confirmedTests[key]} onClick={() => { void runCapabilityTest(binding); }}>测试能力</button>
                {testMessage[key] ? <span role="status">{testMessage[key]}</span> : null}
              </div>
              </div> : null}
            </article>
          );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

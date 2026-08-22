import { useEffect, useState, type FormEvent } from 'react';
import type {
  FamilyModelAdapterKind,
  FamilyModelAuthMode,
  FamilyModelProviderConnectionCheckResult,
  FamilyModelProviderProfile,
  FamilyModelProviderProfileCreate,
  FamilyModelProviderProfilePatch,
} from '../../api/types';
import { DropdownSelect, StateBlock } from '../../components/ui-kit';
import type { FamilyModelProfileRebindOptions } from './familyModelSettingsViewTypes';
import {
  FAMILY_MODEL_ADAPTER_OPTIONS,
  isFamilyModelRealtimeAdapter,
} from './familyModelSettingsOptions';

type CreateInput = Omit<FamilyModelProviderProfileCreate, 'idempotency_key'>;
type PatchInput = Omit<FamilyModelProviderProfilePatch, 'idempotency_key'>;

type PendingRebind = {
  fromProfileId: string;
  toProfileId: string;
};

export type ProviderProfileEditorProps = {
  profiles: FamilyModelProviderProfile[];
  settingsVersionNumber: number;
  selectedProfileId: string | null;
  busy: boolean;
  onSelectProfile: (profileId: string | null) => void;
  onCreate: (input: CreateInput) => Promise<unknown>;
  onPatch: (profileId: string, input: PatchInput) => Promise<unknown>;
  onRotate: (profileId: string, input: {
    new_api_key: string;
    base_settings_version_number: number;
  }) => Promise<unknown>;
  onRebindCreatedProfile?: (
    fromProfileId: string,
    toProfileId: string,
    options?: FamilyModelProfileRebindOptions,
  ) => Promise<void>;
  onCheck: (profileId: string) => Promise<FamilyModelProviderConnectionCheckResult>;
};

type CreateForm = {
  displayName: string;
  adapterKind: FamilyModelAdapterKind;
  authMode: FamilyModelAuthMode;
  apiBaseUrl: string;
  apiKey: string;
};

const INITIAL_CREATE_FORM: CreateForm = {
  displayName: '',
  adapterKind: 'openai_compatible_http',
  authMode: 'api_key',
  apiBaseUrl: '',
  apiKey: '',
};

const PROVIDER_STATUS_OPTIONS = [
  { value: 'active', label: '启用', description: '可继续用于能力绑定和模型调用。' },
  { value: 'disabled', label: '停用', description: '暂时停止使用，保留服务配置。' },
  { value: 'archived', label: '归档', description: '从日常配置中隐藏，仅保留历史记录。' },
] as const;

const AUTH_MODE_OPTIONS = [
  { value: 'api_key', label: 'API Key', description: '请求时使用服务凭据认证。' },
  { value: 'no_auth', label: '无认证（仅受控内网）', description: '仅用于受部署安全策略保护的内网服务。' },
] as const;

function ProfileScopeSummary(props: { profile: FamilyModelProviderProfile }) {
  const isRealtime = isFamilyModelRealtimeAdapter(props.profile.adapter_kind);
  const adapterOption = FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === props.profile.adapter_kind);
  const adapterLabel = adapterOption?.label ?? props.profile.adapter_kind;

  return (
    <div className="family-model-settings-provider-scope">
      <div className="family-model-settings-scope-tile">
        <span className="family-model-settings-scope-label">适配协议</span>
        <strong className="family-model-settings-scope-value">{adapterLabel}</strong>
      </div>
      <div className="family-model-settings-scope-tile">
        <span className="family-model-settings-scope-label">{isRealtime ? '实时服务地址' : 'API 服务地址'}</span>
        <strong className="family-model-settings-scope-value is-mono" title={props.profile.api_base_url}>
          {props.profile.api_base_url}
        </strong>
      </div>
      <div className="family-model-settings-scope-tile">
        <span className="family-model-settings-scope-label">凭据状态</span>
        <span className={`family-model-settings-scope-badge ${props.profile.credential.configured ? 'is-configured' : 'is-missing'}`}>
          <span className="family-model-settings-status-dot" aria-hidden="true" />
          {props.profile.credential.configured ? '已配置 API Key' : '未配置凭据'}
        </span>
      </div>
    </div>
  );
}

export function ProviderProfileEditor(props: ProviderProfileEditorProps) {
  const [creating, setCreating] = useState(false);
  const selectedProfile = creating
    ? null
    : props.profiles.find((profile) => profile.id === props.selectedProfileId)
      ?? props.profiles.find((profile) => profile.status !== 'archived')
      ?? props.profiles[0]
      ?? null;
  const [createForm, setCreateForm] = useState<CreateForm>(INITIAL_CREATE_FORM);
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<FamilyModelProviderProfile['status']>('active');
  const [rotationKey, setRotationKey] = useState('');
  const [showRotation, setShowRotation] = useState(false);
  const [rebindFromProfileId, setRebindFromProfileId] = useState<string | null>(null);
  const [pendingRebind, setPendingRebind] = useState<PendingRebind | null>(null);
  const [retryingRebind, setRetryingRebind] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(selectedProfile?.display_name ?? '');
    setStatus(selectedProfile?.status ?? 'active');
    setShowRotation(false);
    setRotationKey('');
    setConnectionMessage(null);
    if (selectedProfile?.id) setCreateForm(INITIAL_CREATE_FORM);
  }, [selectedProfile?.id]);

  const isRealtime = isFamilyModelRealtimeAdapter(createForm.adapterKind);

  function beginCreate() {
    setCreateForm(INITIAL_CREATE_FORM);
    setPendingRebind(null);
    setRebindFromProfileId(selectedProfile?.id ?? null);
    setCreating(true);
    props.onSelectProfile(null);
  }

  function selectProfile(profileId: string | null) {
    setPendingRebind(null);
    setRebindFromProfileId(null);
    setCreating(profileId === null);
    props.onSelectProfile(profileId);
  }

  function cancelRotation() {
    setRotationKey('');
    setShowRotation(false);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: CreateInput = {
      display_name: createForm.displayName.trim(),
      adapter_kind: createForm.adapterKind,
      auth_mode: createForm.authMode,
      api_base_url: createForm.apiBaseUrl.trim(),
      websocket_base_url: null,
      options: {},
      ...(createForm.authMode === 'api_key' ? { api_key: createForm.apiKey } : {}),
    };
    try {
      const result = await props.onCreate(input);
      // The write-only key is cleared before invalidating/refreshing any query.
      setCreateForm(INITIAL_CREATE_FORM);
      if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
        if (rebindFromProfileId && props.onRebindCreatedProfile) {
          const rebind = { fromProfileId: rebindFromProfileId, toProfileId: result.id };
          setPendingRebind(rebind);
          setRebindFromProfileId(null);
          setCreating(false);
          props.onSelectProfile(result.id);
          try {
            await props.onRebindCreatedProfile(rebind.fromProfileId, rebind.toProfileId);
            setPendingRebind(null);
          } catch {
            // The new profile already exists. Keep only the failed rebind available for retry.
          }
          return;
        }
        setRebindFromProfileId(null);
        setCreating(false);
        props.onSelectProfile(result.id);
      }
    } catch {
      // The workspace holds a safe, non-provider error message for recovery.
    }
  }

  async function retryPendingRebind() {
    if (!pendingRebind || !props.onRebindCreatedProfile || retryingRebind) return;
    setRetryingRebind(true);
    try {
      await props.onRebindCreatedProfile(
        pendingRebind.fromProfileId,
        pendingRebind.toProfileId,
        { refreshServerDraft: true },
      );
      setPendingRebind(null);
    } catch {
      // Keep the existing profile IDs so another retry never recreates the profile.
    } finally {
      setRetryingRebind(false);
    }
  }

  async function submitPatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProfile) return;
    try {
      await props.onPatch(selectedProfile.id, {
        display_name: displayName.trim(),
        status,
        base_profile_version_number: selectedProfile.profile_version_number,
      });
    } catch {
      // The controlled form remains intact after a failed save.
    }
  }

  async function submitRotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProfile) return;
    try {
      await props.onRotate(selectedProfile.id, {
        new_api_key: rotationKey,
        base_settings_version_number: props.settingsVersionNumber,
      });
      setRotationKey('');
      setShowRotation(false);
    } catch {
      // Keep local secret inputs available only for the user's immediate retry.
    }
  }

  async function checkConnection() {
    if (!selectedProfile) return;
    setConnectionMessage(null);
    try {
      const result = await props.onCheck(selectedProfile.id);
      if (result.status === 'not_supported') {
        setConnectionMessage(result.detail ?? '此服务不支持免费连接检查，请在能力配置中手动填写模型。');
      } else if (result.models.length > 0) {
        setConnectionMessage(`服务连接正常，已读取 ${result.models.length} 个模型。`);
      } else {
        setConnectionMessage('服务连接正常，但没有返回模型列表；你仍可在能力配置中手动填写模型。');
      }
    } catch {
      setConnectionMessage('连接检查失败，请稍后重试。');
    }
  }

  return (
    <section className="family-model-settings-editor family-model-settings-provider-editor" aria-labelledby="family-model-provider-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-provider-editor-title">Provider 服务</h2>
          <p>每个服务对应一种连接方式、认证方式和账号范围；API Key 只在提交时使用。</p>
        </div>
        <button type="button" className="ghost-button" disabled={props.busy || retryingRebind} onClick={beginCreate}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16, marginRight: 6 }} aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          新建服务
        </button>
      </div>

      {props.profiles.length > 0 ? (
        <>
          <nav className="family-model-settings-provider-list" aria-label="Provider 服务列表">
            {creating ? (
              <button
                type="button"
                aria-current="true"
                disabled={props.busy || retryingRebind}
                onClick={() => props.onSelectProfile(null)}
              >
                <span className="family-model-settings-provider-list-info">
                  <strong>新建服务</strong>
                  <small>尚未保存</small>
                </span>
                <span className="family-model-settings-provider-status">新建</span>
              </button>
            ) : null}
            {props.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                aria-current={selectedProfile?.id === profile.id ? 'true' : undefined}
                disabled={props.busy || retryingRebind}
                onClick={() => selectProfile(profile.id)}
              >
                <span className="family-model-settings-provider-list-info">
                  <strong>{profile.display_name}</strong>
                  <small>{FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === profile.adapter_kind)?.label ?? profile.adapter_kind}</small>
                </span>
                <span className={`family-model-settings-provider-status is-${profile.status}`}>
                  {profile.status === 'active' ? '启用' : profile.status === 'disabled' ? '停用' : '归档'}
                </span>
              </button>
            ))}
          </nav>
          <div className="family-model-settings-field family-model-settings-provider-select">
            <span>当前服务</span>
            <DropdownSelect
              ariaLabel="当前服务选项"
              triggerAriaLabel="当前服务"
              placeholder="新建 Provider 服务"
              value={selectedProfile?.id ?? ''}
              options={props.profiles.map((profile) => ({
                value: profile.id,
                label: profile.display_name,
                description: FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === profile.adapter_kind)?.label
                  ?? profile.adapter_kind,
              }))}
              clearOption={{
                value: '',
                label: '新建 Provider 服务',
                description: '创建新的连接地址与凭据范围。',
              }}
              disabled={props.busy || retryingRebind}
              className="family-model-settings-dropdown"
              onChange={(value) => selectProfile(value || null)}
            />
          </div>
        </>
      ) : null}

      {pendingRebind ? (
        <div className="family-model-settings-provider-existing">
          <StateBlock
            status="error"
            title="新服务已创建，能力改绑未完成"
            description="再次尝试只会更新能力绑定，不会重复创建 Provider 服务。"
          />
          <div className="family-model-settings-editor-actions">
            <button
              className="solid-button"
              type="button"
              disabled={props.busy || retryingRebind}
              onClick={() => { void retryPendingRebind(); }}
            >
              {props.busy || retryingRebind ? '正在改绑' : '重试改绑'}
            </button>
          </div>
        </div>
      ) : selectedProfile ? (
        <div className="family-model-settings-provider-existing">
          <ProfileScopeSummary profile={selectedProfile} />
          <div className="family-model-settings-readonly-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>更换连接地址或账号需要创建新服务，再重新绑定能力。</span>
          </div>
          <form className="family-model-settings-form" onSubmit={submitPatch}>
            <div className="family-model-settings-form-grid">
              <label className="family-model-settings-field">
                <span>显示名称</span>
                <input value={displayName} disabled={props.busy} onChange={(event) => setDisplayName(event.target.value)} required />
              </label>
              <div className="family-model-settings-field">
                <span>状态</span>
                <DropdownSelect
                  ariaLabel="状态选项"
                  triggerAriaLabel="状态"
                  placeholder="选择状态"
                  value={status}
                  options={PROVIDER_STATUS_OPTIONS}
                  disabled={props.busy}
                  className="family-model-settings-dropdown"
                  onChange={(value) => { if (value) setStatus(value); }}
                />
              </div>
            </div>
            <div className="family-model-settings-editor-actions">
              <button className="ghost-button" type="button" disabled={props.busy} onClick={() => { void checkConnection(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, marginRight: 6 }} aria-hidden="true">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
                检查连接
              </button>
              <button className="solid-button" type="submit" disabled={props.busy}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, marginRight: 6 }} aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {props.busy ? '正在保存' : '保存服务'}
              </button>
            </div>
            {connectionMessage ? <p className="family-model-settings-inline-status" role="status">{connectionMessage}</p> : null}
          </form>

          <div className="family-model-settings-key-rotation">
            <div className="family-model-settings-key-rotation-header">
              <div className="family-model-settings-key-rotation-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-1.5 1.5L12 11l-4-4-6 6a3 3 0 0 0 4.24 4.24l6-6-4-4 5.5-5.5" />
                  <circle cx="16.5" cy="7.5" r="1.5" fill="currentColor" />
                </svg>
              </div>
              <div>
                <strong>修改 API Key</strong>
                <p>新 Key 保存后立即用于当前服务，不会更换地址、账号或模型绑定。</p>
              </div>
            </div>
            <button className="tertiary-button" type="button" disabled={props.busy} onClick={() => { if (showRotation) cancelRotation(); else setShowRotation(true); }}>
              {showRotation ? '收起' : '修改 Key'}
            </button>
          </div>
          {showRotation ? (
            <form className="family-model-settings-form family-model-settings-key-update-form" onSubmit={submitRotation}>
              <div className="family-model-settings-form-grid">
                <label className="family-model-settings-field">
                  <span>新的 API Key</span>
                  <input type="password" autoComplete="new-password" placeholder="输入同一服务范围的新 API Key" value={rotationKey} disabled={props.busy} onChange={(event) => setRotationKey(event.target.value)} required />
                </label>
              </div>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={props.busy} onClick={cancelRotation}>取消</button>
                <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在修改' : '确认修改'}</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
        <form className="family-model-settings-form" onSubmit={submitCreate}>
          <div className="family-model-settings-form-section">
            <h3 className="family-model-settings-form-section-title">基本信息</h3>
            <div className="family-model-settings-form-grid">
              <label className="family-model-settings-field">
                <span>服务名称</span>
                <input value={createForm.displayName} disabled={props.busy} placeholder="例如：家庭主服务" onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))} required />
              </label>
              <div className="family-model-settings-field">
                <span>协议适配器</span>
                <DropdownSelect
                  ariaLabel="协议适配器选项"
                  triggerAriaLabel="协议适配器"
                  placeholder="选择协议适配器"
                  value={createForm.adapterKind}
                  options={FAMILY_MODEL_ADAPTER_OPTIONS}
                  disabled={props.busy}
                  className="family-model-settings-dropdown"
                  onChange={(adapterKind) => {
                    if (!adapterKind) return;
                    setCreateForm((current) => ({
                      ...current,
                      adapterKind,
                      apiBaseUrl: isFamilyModelRealtimeAdapter(current.adapterKind) === isFamilyModelRealtimeAdapter(adapterKind)
                        ? current.apiBaseUrl
                        : '',
                      authMode: isFamilyModelRealtimeAdapter(adapterKind) ? 'api_key' : current.authMode,
                    }));
                  }}
                />
              </div>
            </div>
          </div>

          <div className="family-model-settings-form-section">
            <h3 className="family-model-settings-form-section-title">连接与认证</h3>
            <div className="family-model-settings-form-grid">
              <label className="family-model-settings-field">
                <span>{isRealtime ? '实时地址' : 'API 地址'}</span>
                <input type="url" value={createForm.apiBaseUrl} disabled={props.busy} placeholder={isRealtime ? 'wss://provider.example/realtime' : 'https://provider.example/v1'} onChange={(event) => setCreateForm((current) => ({ ...current, apiBaseUrl: event.target.value }))} required />
              </label>
              <div className="family-model-settings-field">
                <span>认证方式</span>
                <DropdownSelect
                  ariaLabel="认证方式选项"
                  triggerAriaLabel="认证方式"
                  placeholder="选择认证方式"
                  value={createForm.authMode}
                  options={isRealtime ? AUTH_MODE_OPTIONS.slice(0, 1) : AUTH_MODE_OPTIONS}
                  disabled={props.busy || isRealtime}
                  className="family-model-settings-dropdown"
                  onChange={(authMode) => {
                    if (!authMode) return;
                    setCreateForm((current) => ({
                      ...current,
                      authMode,
                      apiKey: authMode === 'no_auth' ? '' : current.apiKey,
                    }));
                  }}
                />
              </div>
              {createForm.authMode === 'api_key' ? (
                <label className="family-model-settings-field">
                  <span>API Key</span>
                  <input type="password" autoComplete="new-password" value={createForm.apiKey} disabled={props.busy} placeholder="输入 API Key" onChange={(event) => setCreateForm((current) => ({ ...current, apiKey: event.target.value }))} required />
                </label>
              ) : null}
            </div>
          </div>

          <p className="family-model-settings-write-only-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, marginRight: 6, verticalAlign: -2 }} aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            API Key 不会再次显示、复制或保存到浏览器。
          </p>
          <div className="family-model-settings-editor-actions">
            <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在创建' : '创建服务'}</button>
          </div>
        </form>
      )}
    </section>
  );
}

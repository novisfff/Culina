import { useEffect, useState, type FormEvent } from 'react';
import type {
  FamilyModelAdapterKind,
  FamilyModelAuthMode,
  FamilyModelProviderProfile,
  FamilyModelProviderProfileCreate,
  FamilyModelProviderProfilePatch,
} from '../../api/types';
import { StateBlock } from '../../components/ui-kit';
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
    current_password: string;
    new_api_key: string;
    base_settings_version_number: number;
  }) => Promise<unknown>;
  onRebindCreatedProfile?: (
    fromProfileId: string,
    toProfileId: string,
    options?: FamilyModelProfileRebindOptions,
  ) => Promise<void>;
  onCheck: (profileId: string) => Promise<unknown>;
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

function ProfileScopeSummary(props: { profile: FamilyModelProviderProfile }) {
  const isRealtime = isFamilyModelRealtimeAdapter(props.profile.adapter_kind);
  return (
    <dl className="family-model-settings-provider-scope">
      <div><dt>{isRealtime ? '实时地址' : 'API 地址'}</dt><dd>{props.profile.api_base_url}</dd></div>
      <div><dt>凭据状态</dt><dd>{props.profile.credential.configured ? '已配置' : '未配置'}</dd></div>
    </dl>
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
  const [rotationPassword, setRotationPassword] = useState('');
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
    setRotationPassword('');
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
    setRotationPassword('');
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
        current_password: rotationPassword,
        new_api_key: rotationKey,
        base_settings_version_number: props.settingsVersionNumber,
      });
      setRotationPassword('');
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
      setConnectionMessage(result && typeof result === 'object' && 'status' in result && result.status === 'succeeded'
        ? '服务连接检查通过。'
        : '连接检查未通过，请检查服务地址与凭据。');
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
            {props.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                aria-current={selectedProfile?.id === profile.id ? 'true' : undefined}
                disabled={props.busy || retryingRebind}
                onClick={() => selectProfile(profile.id)}
              >
                <span>
                  <strong>{profile.display_name}</strong>
                  <small>{FAMILY_MODEL_ADAPTER_OPTIONS.find((option) => option.value === profile.adapter_kind)?.label ?? profile.adapter_kind}</small>
                </span>
                <span className={`family-model-settings-provider-status is-${profile.status}`}>
                  {profile.status === 'active' ? '启用' : profile.status === 'disabled' ? '停用' : '归档'}
                </span>
              </button>
            ))}
          </nav>
          <label className="family-model-settings-field family-model-settings-provider-select">
            <span>当前服务</span>
            <select
              value={selectedProfile?.id ?? ''}
              disabled={props.busy || retryingRebind}
              onChange={(event) => selectProfile(event.target.value || null)}
            >
              <option value="">新建 Provider 服务</option>
              {props.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
            </select>
          </label>
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
          <p className="family-model-settings-readonly-note">更换连接地址或账号需要创建新服务，再重新绑定能力。</p>
          <form className="family-model-settings-form" onSubmit={submitPatch}>
            <div className="family-model-settings-form-grid">
              <label className="family-model-settings-field">
                <span>显示名称</span>
                <input value={displayName} disabled={props.busy} onChange={(event) => setDisplayName(event.target.value)} required />
              </label>
              <label className="family-model-settings-field">
                <span>状态</span>
                <select value={status} disabled={props.busy} onChange={(event) => setStatus(event.target.value as FamilyModelProviderProfile['status'])}>
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                  <option value="archived">归档</option>
                </select>
              </label>
            </div>
            <div className="family-model-settings-editor-actions">
              <button className="ghost-button" type="button" disabled={props.busy} onClick={() => { void checkConnection(); }}>检查连接</button>
              <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在保存' : '保存服务'}</button>
            </div>
            {connectionMessage ? <p className="family-model-settings-inline-status" role="status">{connectionMessage}</p> : null}
          </form>

          <div className="family-model-settings-key-rotation">
            <div>
              <strong>轮换 API Key</strong>
              <p>仅适用于当前服务范围，不会更换地址、账号或模型绑定。</p>
            </div>
            <button className="tertiary-button" type="button" disabled={props.busy} onClick={() => { if (showRotation) cancelRotation(); else setShowRotation(true); }}>
              {showRotation ? '收起轮换' : '轮换 Key'}
            </button>
          </div>
          {showRotation ? (
            <form className="family-model-settings-form family-model-settings-key-rotation-form" onSubmit={submitRotation}>
              <div className="family-model-settings-form-grid">
                <label className="family-model-settings-field">
                  <span>当前密码</span>
                  <input type="password" autoComplete="current-password" value={rotationPassword} disabled={props.busy} onChange={(event) => setRotationPassword(event.target.value)} required />
                </label>
                <label className="family-model-settings-field">
                  <span>新的 API Key</span>
                  <input type="password" autoComplete="new-password" placeholder="输入同一服务范围的新 API Key" value={rotationKey} disabled={props.busy} onChange={(event) => setRotationKey(event.target.value)} required />
                </label>
              </div>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={props.busy} onClick={cancelRotation}>取消</button>
                <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在轮换' : '确认轮换'}</button>
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
              <label className="family-model-settings-field">
                <span>协议适配器</span>
                <select
                  value={createForm.adapterKind}
                  disabled={props.busy}
                  onChange={(event) => {
                    const adapterKind = event.target.value as FamilyModelAdapterKind;
                    setCreateForm((current) => ({
                      ...current,
                      adapterKind,
                      apiBaseUrl: isFamilyModelRealtimeAdapter(current.adapterKind) === isFamilyModelRealtimeAdapter(adapterKind)
                        ? current.apiBaseUrl
                        : '',
                      authMode: isFamilyModelRealtimeAdapter(adapterKind) ? 'api_key' : current.authMode,
                    }));
                  }}
                >
                  {FAMILY_MODEL_ADAPTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="family-model-settings-form-section">
            <h3 className="family-model-settings-form-section-title">连接与认证</h3>
            <div className="family-model-settings-form-grid">
              <label className="family-model-settings-field">
                <span>{isRealtime ? '实时地址' : 'API 地址'}</span>
                <input type="url" value={createForm.apiBaseUrl} disabled={props.busy} placeholder={isRealtime ? 'wss://provider.example/realtime' : 'https://provider.example/v1'} onChange={(event) => setCreateForm((current) => ({ ...current, apiBaseUrl: event.target.value }))} required />
              </label>
              <label className="family-model-settings-field">
                <span>认证方式</span>
                <select value={createForm.authMode} disabled={props.busy || isRealtime} onChange={(event) => setCreateForm((current) => ({ ...current, authMode: event.target.value as FamilyModelAuthMode, apiKey: event.target.value === 'no_auth' ? '' : current.apiKey }))}>
                  <option value="api_key">API Key</option>
                  {!isRealtime ? <option value="no_auth">无认证（仅受控内网）</option> : null}
                </select>
              </label>
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

import { useEffect, useState, type FormEvent } from 'react';
import type {
  FamilyModelAdapterKind,
  FamilyModelAuthMode,
  FamilyModelProviderProfile,
  FamilyModelProviderProfileCreate,
  FamilyModelProviderProfilePatch,
} from '../../api/types';
import { StateBlock } from '../../components/ui-kit';
import { FAMILY_MODEL_ADAPTER_OPTIONS } from './familyModelSettingsOptions';

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
  onRebindCreatedProfile?: (fromProfileId: string, toProfileId: string) => Promise<void>;
  onCheck: (profileId: string) => Promise<unknown>;
};

type CreateForm = {
  displayName: string;
  adapterKind: FamilyModelAdapterKind;
  authMode: FamilyModelAuthMode;
  apiBaseUrl: string;
  websocketBaseUrl: string;
  apiKey: string;
  workspaceId: string;
  region: string;
  projectId: string;
};

const INITIAL_CREATE_FORM: CreateForm = {
  displayName: '',
  adapterKind: 'openai_compatible_http',
  authMode: 'api_key',
  apiBaseUrl: '',
  websocketBaseUrl: '',
  apiKey: '',
  workspaceId: '',
  region: '',
  projectId: '',
};

function safeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function ProfileScopeSummary(props: { profile: FamilyModelProviderProfile }) {
  const options = props.profile.options;
  const scope = [options.workspace_id, options.region, options.project_id].filter(Boolean).join(' · ');
  return (
    <dl className="family-model-settings-provider-scope">
      <div><dt>服务地址</dt><dd>{props.profile.api_base_url}</dd></div>
      {props.profile.websocket_base_url ? <div><dt>实时地址</dt><dd>{props.profile.websocket_base_url}</dd></div> : null}
      <div><dt>服务范围</dt><dd>{scope || '未额外指定'}</dd></div>
      <div><dt>凭据状态</dt><dd>{props.profile.credential.configured ? '已配置' : '未配置'}</dd></div>
    </dl>
  );
}

export function ProviderProfileEditor(props: ProviderProfileEditorProps) {
  const selectedProfile = props.profiles.find((profile) => profile.id === props.selectedProfileId) ?? null;
  const [createForm, setCreateForm] = useState<CreateForm>(INITIAL_CREATE_FORM);
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<FamilyModelProviderProfile['status']>('active');
  const [rotationPassword, setRotationPassword] = useState('');
  const [rotationKey, setRotationKey] = useState('');
  const [showRotation, setShowRotation] = useState(false);
  const [rebindFromProfileId, setRebindFromProfileId] = useState<string | null>(null);
  const [pendingRebind, setPendingRebind] = useState<PendingRebind | null>(null);
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

  const isRealtime = createForm.adapterKind === 'openai_realtime' || createForm.adapterKind === 'dashscope_realtime';

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: CreateInput = {
      display_name: createForm.displayName.trim(),
      adapter_kind: createForm.adapterKind,
      auth_mode: createForm.authMode,
      api_base_url: createForm.apiBaseUrl.trim(),
      websocket_base_url: safeOptional(createForm.websocketBaseUrl),
      options: {
        workspace_id: safeOptional(createForm.workspaceId),
        region: safeOptional(createForm.region),
        project_id: safeOptional(createForm.projectId),
      },
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
        props.onSelectProfile(result.id);
      }
    } catch {
      // The workspace holds a safe, non-provider error message for recovery.
    }
  }

  async function retryPendingRebind() {
    if (!pendingRebind || !props.onRebindCreatedProfile) return;
    try {
      await props.onRebindCreatedProfile(pendingRebind.fromProfileId, pendingRebind.toProfileId);
      setPendingRebind(null);
    } catch {
      // Keep the existing profile IDs so another retry never recreates the profile.
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
    try {
      const result = await props.onCheck(selectedProfile.id);
      setConnectionMessage(
        result && typeof result === 'object' && 'status' in result && result.status === 'reachable'
          ? '安全检查已通过，尚未执行真实调用。'
          : '当前服务不支持安全检查。',
      );
    } catch {
      setConnectionMessage(null);
    }
  }

  function beginCreate() {
    setCreateForm(INITIAL_CREATE_FORM);
    setPendingRebind(null);
    setRebindFromProfileId(selectedProfile?.id ?? null);
    props.onSelectProfile(null);
  }

  function selectProfile(profileId: string | null) {
    setPendingRebind(null);
    setRebindFromProfileId(null);
    props.onSelectProfile(profileId);
  }

  function cancelRotation() {
    setRotationPassword('');
    setRotationKey('');
    setShowRotation(false);
  }

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-provider-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-provider-editor-title">Provider 档案</h2>
          <p>一个档案固定一个服务地址、认证方式和账号范围；API Key 只在提交时使用。</p>
        </div>
        <button type="button" className="ghost-button" disabled={props.busy} onClick={beginCreate}>新建档案</button>
      </div>

      {props.profiles.length > 0 ? (
        <label className="family-model-settings-field">
          <span>当前档案</span>
          <select
            value={selectedProfile?.id ?? ''}
            disabled={props.busy}
            onChange={(event) => selectProfile(event.target.value || null)}
          >
            <option value="">新建 Provider 档案</option>
            {props.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
          </select>
        </label>
      ) : null}

      {pendingRebind ? (
        <div className="family-model-settings-provider-existing">
          <StateBlock
            status="error"
            title="新档案已创建，能力改绑未完成"
            description="再次尝试只会更新能力绑定，不会重复创建 Provider 档案。"
          />
          <div className="family-model-settings-editor-actions">
            <button
              className="solid-button"
              type="button"
              disabled={props.busy}
              onClick={() => { void retryPendingRebind(); }}
            >
              {props.busy ? '正在改绑' : '重试改绑'}
            </button>
          </div>
        </div>
      ) : selectedProfile ? (
        <div className="family-model-settings-provider-existing">
          <ProfileScopeSummary profile={selectedProfile} />
          <p className="family-model-settings-readonly-note">更换服务地址或账号需要创建新档案，再重新绑定能力。</p>
          <form className="family-model-settings-form" onSubmit={submitPatch}>
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
            <div className="family-model-settings-editor-actions">
              <button className="ghost-button" type="button" disabled={props.busy} onClick={() => { void checkConnection(); }}>检查连接</button>
              <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在保存' : '保存档案'}</button>
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
              <label className="family-model-settings-field">
                <span>当前密码</span>
                <input type="password" autoComplete="current-password" value={rotationPassword} disabled={props.busy} onChange={(event) => setRotationPassword(event.target.value)} required />
              </label>
              <label className="family-model-settings-field">
                <span>新的 API Key</span>
                <input type="password" autoComplete="new-password" placeholder="输入同一服务范围的新 API Key" value={rotationKey} disabled={props.busy} onChange={(event) => setRotationKey(event.target.value)} required />
              </label>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={props.busy} onClick={cancelRotation}>取消</button>
                <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在轮换' : '确认轮换'}</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
        <form className="family-model-settings-form" onSubmit={submitCreate}>
          <div className="family-model-settings-form-grid">
            <label className="family-model-settings-field">
              <span>档案名称</span>
              <input value={createForm.displayName} disabled={props.busy} placeholder="例如：家庭主服务" onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))} required />
            </label>
            <label className="family-model-settings-field">
              <span>协议适配器</span>
              <select value={createForm.adapterKind} disabled={props.busy} onChange={(event) => setCreateForm((current) => ({ ...current, adapterKind: event.target.value as FamilyModelAdapterKind }))}>
                {FAMILY_MODEL_ADAPTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="family-model-settings-field">
              <span>{isRealtime ? 'WebSocket 服务地址' : 'API 服务地址'}</span>
              <input type="url" value={createForm.apiBaseUrl} disabled={props.busy} placeholder={isRealtime ? 'wss://provider.example/realtime' : 'https://provider.example/v1'} onChange={(event) => setCreateForm((current) => ({ ...current, apiBaseUrl: event.target.value }))} required />
            </label>
            {!isRealtime ? (
              <label className="family-model-settings-field">
                <span>可选实时地址</span>
                <input type="url" value={createForm.websocketBaseUrl} disabled={props.busy} placeholder="wss://provider.example/realtime" onChange={(event) => setCreateForm((current) => ({ ...current, websocketBaseUrl: event.target.value }))} />
              </label>
            ) : null}
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
            <label className="family-model-settings-field">
              <span>工作区（可选）</span>
              <input value={createForm.workspaceId} disabled={props.busy} onChange={(event) => setCreateForm((current) => ({ ...current, workspaceId: event.target.value }))} />
            </label>
            <label className="family-model-settings-field">
              <span>区域（可选）</span>
              <input value={createForm.region} disabled={props.busy} onChange={(event) => setCreateForm((current) => ({ ...current, region: event.target.value }))} />
            </label>
            <label className="family-model-settings-field">
              <span>项目（可选）</span>
              <input value={createForm.projectId} disabled={props.busy} onChange={(event) => setCreateForm((current) => ({ ...current, projectId: event.target.value }))} />
            </label>
          </div>
          <p className="family-model-settings-write-only-note">API Key 不会再次显示、复制或保存到浏览器。</p>
          <div className="family-model-settings-editor-actions">
            <button className="solid-button" type="submit" disabled={props.busy}>{props.busy ? '正在创建' : '创建档案'}</button>
          </div>
        </form>
      )}
    </section>
  );
}

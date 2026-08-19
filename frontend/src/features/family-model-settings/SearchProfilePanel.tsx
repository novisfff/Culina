import { useMemo, useState } from 'react';
import type {
  FamilyModelPriceRate,
  FamilyModelSearchReplacementPreviewResult,
} from '../../api/types';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';
import { profileSupportsCapability } from './familyModelSettingsOptions';

type SearchProfilePanelProps = Pick<FamilyModelSettingsSurfaceProps,
  | 'settings'
  | 'draft'
  | 'actions'
  | 'busyAction'
  | 'searchReplacement'
  | 'replacementProfileId'
  | 'onReplacementProfileIdChange'
>;

export function SearchProfilePanel(props: SearchProfilePanelProps) {
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
  const busy = props.busyAction !== null;
  const activeSearchProfileId = props.settings.active_search_profile_id;
  const replacement = props.searchReplacement;
  const rates = props.draft.price_rates.filter((rate) => rate.capability === 'embedding');

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
    <section className="family-model-settings-editor" aria-labelledby="family-model-search-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-search-title">搜索索引</h2>
          <p>搜索向量的身份独立于普通配置。完整重建期间会继续使用当前搜索索引。</p>
        </div>
      </div>
      <div className="family-model-settings-search-summary">
        <strong>{activeSearchProfileId ? '当前搜索索引已启用' : '尚未建立搜索索引'}</strong>
        <span>{activeSearchProfileId ? '如需更换向量模型、地址或维度，请创建替换索引。' : '首次启用 Embedding 并发布配置后，系统会准备搜索索引。'}</span>
      </div>

      {replacement ? (
        <section className="family-model-settings-search-progress" aria-live="polite">
          <div>
            <h3>替换索引进度</h3>
            <p>{replacement.status === 'provisioning' ? '正在完整重建，当前搜索索引仍可继续使用。' : replacement.status === 'failed' ? '重建失败，原搜索索引没有被替换。' : `当前状态：${replacement.status}`}</p>
          </div>
          <strong>{replacement.indexed_documents} / {replacement.total_documents}</strong>
          {replacement.failed_documents > 0 ? <span>失败 {replacement.failed_documents} 项</span> : null}
          <div className="family-model-settings-editor-actions">
            {replacement.status === 'failed' && replacement.retryable ? <button className="ghost-button" type="button" disabled={busy} onClick={() => { void retryReplacement(); }}>重试重建</button> : null}
            {(replacement.status === 'provisioning' || replacement.status === 'failed') ? <button className="tertiary-button" type="button" disabled={busy} onClick={() => { void cancelReplacement(); }}>取消重建</button> : null}
          </div>
        </section>
      ) : null}

      {activeSearchProfileId ? (
        <div className="family-model-settings-search-replacement">
          <h3>创建替换索引</h3>
          <div className="family-model-settings-form-grid">
            <label className="family-model-settings-field">
              <span>新的 Provider 档案</span>
              <select value={providerProfileId} disabled={busy} onChange={(event) => { setProviderProfileId(event.target.value); setPreview(null); }}>
                <option value="">选择兼容档案</option>
                {embeddingProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
              </select>
            </label>
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
            <button className="ghost-button" type="button" disabled={busy || !providerProfileId || !requestedModel.trim() || rates.length === 0} onClick={() => { void previewReplacement(); }}>评估完整重建</button>
          </div>
          {preview ? (
            <section className="family-model-settings-search-confirmation">
              <p>预计处理 {preview.document_count} 份家庭文档，保守费用约 ¥{preview.conservative_estimated_cost_cny}。</p>
              <p>完整重建期间继续使用当前搜索索引。</p>
              <label className="family-model-settings-field">
                <span>当前密码</span>
                <input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(event) => setCurrentPassword(event.target.value)} />
              </label>
              <label className="family-model-settings-checkbox-field">
                <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>我确认开始完整重建，并理解原索引会继续提供搜索。</span>
              </label>
              <div className="family-model-settings-editor-actions">
                <button className="ghost-button" type="button" disabled={busy} onClick={() => setPreview(null)}>取消</button>
                <button className="solid-button" type="button" disabled={busy || !currentPassword || !confirmed} onClick={() => { void startReplacement(); }}>{busy ? '正在开始' : '开始完整重建'}</button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

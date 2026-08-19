import { useEffect, useMemo, useState } from 'react';
import { validateFamilyModelPriceRates } from './familyModelSettingsModel';
import { FAMILY_MODEL_CAPABILITY_OPTIONS } from './familyModelSettingsOptions';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';

type PublishReviewProps = Pick<FamilyModelSettingsSurfaceProps,
  | 'settings'
  | 'draft'
  | 'validation'
  | 'busyAction'
  | 'errorMessage'
  | 'onValidate'
  | 'onPublish'
>;

export function PublishReview(props: PublishReviewProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const priceValidation = useMemo(
    () => validateFamilyModelPriceRates(props.draft.bindings, props.draft.price_rates),
    [props.draft.bindings, props.draft.price_rates],
  );
  const busy = props.busyAction !== null;
  const canPublish = Boolean(
    props.validation?.valid
      && props.validation.config_checksum
      && props.validation.price_checksum
      && priceValidation.valid
      && currentPassword
      && confirmed,
  );

  useEffect(() => {
    setConfirmed(false);
  }, [props.validation?.config_checksum, props.validation?.price_checksum]);

  async function publish() {
    if (!props.validation?.config_checksum || !props.validation.price_checksum) return;
    try {
      await props.onPublish({
        currentPassword,
        configChecksum: props.validation.config_checksum,
        priceChecksum: props.validation.price_checksum,
      });
      setCurrentPassword('');
      setConfirmed(false);
    } catch {
      // Keep confirmation inputs available for a safe retry after a conflict.
    }
  }

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-settings-review-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-settings-review-title">发布复核</h2>
          <p>发布会同时固定能力、价格和搜索影响；请先检查配置，再进行一次性确认。</p>
        </div>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => { void props.onValidate(); }}>{busy ? '正在检查' : '检查配置'}</button>
      </div>
      <div className="family-model-settings-review-list">
        {props.draft.bindings.map((binding) => {
          const profile = props.settings.provider_profiles.find((candidate) => candidate.id === binding.provider_profile_id);
          return (
            <article key={`${binding.capability}:${binding.variant_key}`}>
              <div>
                <strong>{FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].label}</strong>
                <span>{binding.variant_key}</span>
              </div>
              <p>{binding.enabled
                ? `${profile?.display_name ?? '未选择 Provider'} · ${binding.requested_model || '未填写模型'}`
                : '未启用'}</p>
            </article>
          );
        })}
      </div>
      <div className={`family-model-settings-review-coverage ${priceValidation.valid ? 'is-ready' : 'is-warning'}`}>
        <strong>{priceValidation.valid ? '已覆盖所有启用能力价格' : '价格覆盖尚不完整'}</strong>
        <span>{priceValidation.valid ? `当前有 ${props.draft.price_rates.length} 条计价规则。` : '请返回价格分区补齐启用能力的所有计量项。'}</span>
      </div>
      {props.validation ? (
        <div className={`family-model-settings-review-validation ${props.validation.valid ? 'is-ready' : 'is-error'}`}>
          <strong>{props.validation.valid ? '配置检查已通过' : '配置检查未通过'}</strong>
          {props.validation.valid ? <span>复核结果会绑定当前草稿，修改任一字段后需要重新检查。</span> : <span>请修复标记的问题后再次检查。</span>}
        </div>
      ) : <p className="family-model-settings-validation-note">尚未检查当前草稿。</p>}
      {props.validation?.valid && props.validation.config_checksum && props.validation.price_checksum ? (
        <div className="family-model-settings-publish-confirmation">
          <label className="family-model-settings-field">
            <span>当前密码</span>
            <input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(event) => setCurrentPassword(event.target.value)} />
          </label>
          <label className="family-model-settings-checkbox-field">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>我已核对能力、价格和搜索影响</span>
          </label>
          <button className="solid-button" type="button" disabled={!canPublish} onClick={() => { void publish(); }}>{busy ? '正在发布' : '发布配置'}</button>
        </div>
      ) : null}
      {props.errorMessage ? <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p> : null}
    </section>
  );
}

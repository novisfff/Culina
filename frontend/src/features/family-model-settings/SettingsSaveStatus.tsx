import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';

type Props = Pick<FamilyModelSettingsSurfaceProps, 'busyAction' | 'state' | 'serverDraft' | 'errorMessage' | 'saveFailed' | 'onRetrySave'>;

export function SettingsSaveStatus(props: Props) {
  if (props.errorMessage) {
    return <div className="family-model-settings-save-feedback">
      <p className="family-model-settings-field-error" role="alert">
        {props.saveFailed ? '修改未保存。' : ''}{props.errorMessage}
      </p>
      {props.saveFailed ? <button type="button" className="ghost-button" disabled={props.busyAction !== null} onClick={props.onRetrySave}>重试保存</button> : null}
    </div>;
  }
  const saving = props.busyAction === 'autosave' || props.busyAction === 'save';
  const pending = saving || props.state.dirty;
  const invalid = props.serverDraft.validation_status === 'invalid';
  return <div className="family-model-settings-save-feedback">
    <p className={`family-model-settings-auto-save-status ${pending ? 'is-pending' : 'is-ready'}`} role="status">
      <span className="family-model-settings-status-dot" aria-hidden="true" />
      {saving ? '正在保存…' : props.state.dirty ? '等待保存…' : props.serverDraft.updated_at ? '修改已保存' : '修改会自动保存'}
    </p>
    {!pending && invalid ? <p className="family-model-settings-save-note" role="status">部分配置未通过校验，相关功能仍使用原配置。</p> : null}
  </div>;
}

import { useId } from 'react';

export function ModelBooleanField({ label, hint, checked, disabled, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return <div className="family-model-settings-field">
    <span id={`${id}-label`}>{label}</span>
    <label className="family-model-settings-toggle-card">
      <span className="family-model-settings-toggle-card-value" aria-hidden="true">{checked ? '已开启' : '未开启'}</span>
      <input type="checkbox" checked={checked} disabled={disabled}
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)} />
      <span className="family-model-settings-switch-track" aria-hidden="true" />
    </label>
    <small id={`${id}-hint`}>{hint}</small>
  </div>;
}

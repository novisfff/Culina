import { useEffect, useId, useState } from 'react';

/** Keep incomplete edits local so clearing a field never saves a different value. */
export function ModelIntegerField({ label, value, max, disabled, hint, onChange, onValidityChange }: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  hint?: string;
  onChange: (value: number) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [text, setText] = useState(String(value));
  const id = useId();
  useEffect(() => { setText(String(value)); }, [value]);
  const valid = /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= max;
  return <label className="family-model-settings-field">
    <span>{label}</span>
    <input aria-label={label} type="text" inputMode="numeric" value={text} disabled={disabled}
      aria-invalid={!valid} aria-describedby={[!valid ? id : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onValidityChange(/^\d+$/.test(next) && Number(next) >= 1 && Number(next) <= max);
      }}
      onBlur={() => { if (valid && Number(text) !== value) onChange(Number(text)); }} />
    {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    {!valid ? <small id={id} role="alert">请输入 1–{max} 的整数；当前修改尚未保存。</small> : null}
  </label>;
}

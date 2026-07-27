import { AiDraftField } from './AiDraftField';

function splitTextList(value: string) {
  return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeAiDraftTagValues(value: unknown) {
  const values = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? splitTextList(value)
      : [];
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

export function AiDraftTagInput(props: {
  label: string;
  values: readonly string[];
  disabled: boolean;
  placeholder: string;
  onChange: (values: string[]) => void;
  helpText?: string;
  className?: string;
}) {
  return (
    <AiDraftField label={props.label} helpText={props.helpText} className={['ai-draft-tag-input', props.className].filter(Boolean).join(' ')}>
      <input
        className="text-input"
        aria-label={props.label}
        value={props.values.join('、')}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(normalizeAiDraftTagValues(event.target.value))}
      />
      {props.values.length > 0 ? (
        <div className="ai-draft-tag-preview ai-tag-preview" aria-label={`${props.label}预览`}>
          {props.values.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </AiDraftField>
  );
}

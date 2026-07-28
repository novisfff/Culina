import { useState } from 'react';
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
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const values = normalizeAiDraftTagValues(props.values);

  const commitDraft = () => {
    const additions = normalizeAiDraftTagValues(draft);
    if (additions.length > 0) {
      props.onChange(normalizeAiDraftTagValues([...values, ...additions]));
    }
    setDraft('');
    setEditing(false);
  };

  return (
    <AiDraftField label={props.label} helpText={props.helpText} className={['ai-draft-tag-input', props.className].filter(Boolean).join(' ')}>
      <div className="ai-draft-tag-editor" aria-label={`${props.label}标签列表`}>
        {values.map((value) => props.disabled ? (
          <span className="ai-draft-tag-chip" data-draft-tag={value} key={value}>{value}</span>
        ) : (
          <button
            className="ai-draft-tag-chip is-removable"
            data-draft-tag={value}
            type="button"
            aria-label={`删除${props.label}：${value}`}
            key={value}
            onClick={() => props.onChange(values.filter((item) => item !== value))}
          >
            <span>{value}</span>
            <span className="ai-draft-tag-remove-mark" aria-hidden="true">×</span>
          </button>
        ))}
        {props.disabled && values.length === 0 ? <span className="ai-draft-tag-empty">未填写</span> : null}
        {!props.disabled && (editing ? (
          <input
            className="ai-draft-tag-entry"
            aria-label={`添加${props.label}`}
            value={draft}
            autoFocus
            placeholder="输入后回车"
            onBlur={commitDraft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft('');
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="ai-draft-tag-add"
            type="button"
            title={`例如：${props.placeholder}`}
            onClick={() => setEditing(true)}
          >
            <span aria-hidden="true">＋</span>
            添加标签
          </button>
        ))}
      </div>
    </AiDraftField>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const AI_RESOURCE_PLACEHOLDER_URL = '/assets/ai-food-ingredient-placeholder.png';

function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textFromUnknownItem(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  return asText(record.name) || asText(record.title) || asText(record.label) || asText(record.ingredient_name) || asText(record.ingredientName);
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export type AiResourceKind = 'food' | 'ingredient';

export type AiResourceOption = {
  id: string;
  label: string;
  description?: string;
  imageUrl: string;
  unit?: string;
};

export type AiResourceOptionLoader = (
  kind: AiResourceKind,
  params: { query: string; offset: number; limit: number },
) => Promise<AiResourceOption[]>;

type MealPlanIngredientItem = {
  ingredientId: string;
  name: string;
  quantity: number;
  unit: string;
};

function ResourceThumbnail({ option }: { option?: AiResourceOption | null }) {
  return <img className="ai-resource-thumbnail" src={option?.imageUrl ?? AI_RESOURCE_PLACEHOLDER_URL} alt="" />;
}

export function ResourceSelectIcon({ kind }: { kind: 'calendar' | 'meal' | 'difficulty' | 'type' | 'step' }) {
  if (kind === 'calendar') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.5" y="5.5" width="15" height="14" rx="3" />
        <path d="M8 3.8v3.4M16 3.8v3.4M4.8 10h14.4" />
      </svg>
    );
  }
  if (kind === 'meal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4v16M4.8 4v5.2A2.2 2.2 0 0 0 7 11.4a2.2 2.2 0 0 0 2.2-2.2V4" />
        <path d="M15.2 4.5c2.4.8 3.8 2.7 3.8 5.4 0 2.2-1 4-2.7 4.9V20" />
      </svg>
    );
  }
  if (kind === 'difficulty') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 18.5V14M12 18.5V9M19 18.5V4.5" />
      </svg>
    );
  }
  if (kind === 'type') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6.5h14M5 12h14M5 17.5h9" />
      </svg>
    );
  }
  if (kind === 'step') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 5.5h12M7 12h12M7 18.5h12" />
        <circle cx="4" cy="5.5" r="1" />
        <circle cx="4" cy="12" r="1" />
        <circle cx="4" cy="18.5" r="1" />
      </svg>
    );
  }
  return null;
}

export function ApprovalSelectField({
  label,
  value,
  disabled,
  options,
  icon = 'type',
  className = '',
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  icon?: 'meal' | 'difficulty' | 'type' | 'step';
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`ai-resource-field ai-resource-field-choice ${className}`.trim()}>
      <span>{label}</span>
      <div className={`ai-resource-select ai-choice-select${disabled ? ' is-disabled' : ''}`}>
        <ResourceSelectIcon kind={icon} />
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span className="ai-resource-select-chevron" aria-hidden="true" />
      </div>
    </label>
  );
}

export function ApprovalMultiSelectField({
  label,
  values,
  disabled,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onChange: (values: string[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedLabels = options.filter((option) => values.includes(option.value)).map((option) => option.label);
  return (
    <label className="ai-resource-field ai-resource-field-multi">
      <span>{label}</span>
      <div className={`ai-resource-select ai-choice-select${isOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <ResourceSelectIcon kind="meal" />
        <button
          className="ai-multi-select-trigger"
          type="button"
          disabled={disabled}
          aria-expanded={isOpen}
          onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
          onClick={() => setIsOpen((current) => !current)}
        >
          {selectedLabels.length > 0 ? selectedLabels.join('、') : '请选择'}
        </button>
        <span className="ai-resource-select-chevron" aria-hidden="true" />
        {!disabled && isOpen && (
          <div className="ai-resource-menu ai-choice-menu" role="listbox" aria-multiselectable="true">
            {options.map((option) => {
              const selected = values.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChange(selected ? values.filter((value) => value !== option.value) : [...values, option.value])}
                >
                  <span className="ai-choice-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                  <strong>{option.label}</strong>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </label>
  );
}

export function SearchableResourceSelect({
  kind,
  label,
  value,
  selectedLabel,
  placeholder,
  disabled,
  selectedOption,
  loadOptions,
  excludeIds = [],
  onSelect,
}: {
  kind: AiResourceKind;
  label: string;
  value: string;
  selectedLabel?: string;
  placeholder: string;
  disabled: boolean;
  selectedOption?: AiResourceOption | null;
  loadOptions: AiResourceOptionLoader;
  excludeIds?: string[];
  onSelect: (option: AiResourceOption) => void;
}) {
  const pageSize = 6;
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [loadedOptions, setLoadedOptions] = useState<AiResourceOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const requestVersionRef = useRef(0);
  const selected = selectedOption && (selectedOption.id === value || (!value && selectedOption.label === selectedLabel)) ? selectedOption : null;
  const displayValue = isOpen ? query : selected?.label ?? selectedLabel ?? '';
  const excludedIdSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const visibleOptions = loadedOptions.filter((option) => !excludedIdSet.has(option.id) || option.id === value);

  const loadPage = useCallback(async (reset: boolean) => {
    if (disabled || (!reset && (isLoading || !hasMore))) return;
    const version = reset ? requestVersionRef.current + 1 : requestVersionRef.current;
    if (reset) requestVersionRef.current = version;
    const offset = reset ? 0 : loadedOptions.length;
    setIsLoading(true);
    setLoadError(false);
    try {
      const nextOptions = await loadOptions(kind, { query: normalizeSearchText(query), offset, limit: pageSize });
      if (version !== requestVersionRef.current) return;
      setLoadedOptions((current) => {
        const base = reset ? [] : current;
        const merged = new Map(base.map((option) => [option.id, option]));
        nextOptions.forEach((option) => merged.set(option.id, option));
        return Array.from(merged.values());
      });
      setHasMore(nextOptions.length === pageSize);
    } catch {
      if (version === requestVersionRef.current) {
        setLoadError(true);
        setHasMore(false);
      }
    } finally {
      if (version === requestVersionRef.current) setIsLoading(false);
    }
  }, [disabled, hasMore, isLoading, kind, loadOptions, loadedOptions.length, query]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setLoadedOptions([]);
      setHasMore(true);
      setLoadError(false);
      requestVersionRef.current += 1;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void loadPage(true);
    }, query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, query]);

  return (
    <label className={`ai-resource-field ai-resource-field-${kind}`}>
      <span>{label}</span>
      <div className={`ai-resource-select${isOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <ResourceThumbnail option={selected} />
        <input
          type="text"
          value={displayValue}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => setIsOpen(true)}
          onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
        />
        <span className="ai-resource-select-chevron" aria-hidden="true" />
        {!disabled && isOpen && (
          <div
            className="ai-resource-menu"
            role="listbox"
            onScroll={(event) => {
              const menu = event.currentTarget;
              if (menu.scrollHeight - menu.scrollTop - menu.clientHeight <= 36) {
                void loadPage(false);
              }
            }}
          >
            {visibleOptions.length > 0 ? (
              visibleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={option.id === value ? 'is-selected' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(option);
                    setIsOpen(false);
                  }}
                >
                  <ResourceThumbnail option={option} />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              ))
            ) : isLoading ? (
              <p className="ai-resource-menu-state">正在加载...</p>
            ) : loadError ? (
              <p className="ai-resource-menu-state">加载失败，请关闭后重试</p>
            ) : (
              <p className="ai-resource-menu-state">没有匹配项</p>
            )}
            {visibleOptions.length > 0 && (
              <p className="ai-resource-menu-state">
                {isLoading ? '继续加载...' : loadError ? '加载失败，请关闭后重试' : hasMore ? '向下滚动加载更多' : '已加载全部'}
              </p>
            )}
          </div>
        )}
      </div>
    </label>
  );
}

export function normalizeMealPlanIngredientItems(value: unknown, options: AiResourceOption[]): MealPlanIngredientItem[] {
  const rawItems = Array.isArray(value) ? value : [];
  return rawItems.flatMap((value): MealPlanIngredientItem[] => {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const name = typeof value === 'string' ? value : record ? textFromUnknownItem(record) : '';
    if (!name) return [];
    const ingredientId = record ? asText(record.ingredientId) || asText(record.ingredient_id) || asText(record.id) : '';
    const option = options.find((item) => item.id === ingredientId) ?? options.find((item) => item.label === name);
    return [{
      ingredientId: option?.id ?? ingredientId,
      name: option?.label ?? name,
      quantity: Math.max(0.1, asNumber(record?.quantity, 1)),
      unit: asText(record?.unit) || option?.unit || '份',
    }];
  });
}

export function IngredientQuantityPicker({
  label,
  items,
  disabled,
  selectedOptions,
  loadOptions,
  onChange,
}: {
  label: string;
  items: MealPlanIngredientItem[];
  disabled: boolean;
  selectedOptions: AiResourceOption[];
  loadOptions: AiResourceOptionLoader;
  onChange: (items: MealPlanIngredientItem[]) => void;
}) {
  const selectedIds = new Set(items.map((item) => item.ingredientId).filter(Boolean));
  const updateItem = (index: number, patch: Partial<MealPlanIngredientItem>) => {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };

  return (
    <section className="ai-meal-plan-ingredients">
      <div className="ai-meal-plan-ingredients-head">
        <span>{label}</span>
        <small>{items.length > 0 ? `${items.length} 种` : '可选填'}</small>
      </div>
      <div className="ai-meal-plan-ingredient-list">
        {items.map((item, index) => (
          <div className="ai-meal-plan-ingredient-row" key={`${item.ingredientId || item.name}-${index}`}>
            <SearchableResourceSelect
              kind="ingredient"
              label={`食材 ${index + 1}`}
              value={item.ingredientId}
              selectedLabel={item.name}
              placeholder="搜索食材"
              disabled={disabled}
              selectedOption={selectedOptions.find((option) => option.id === item.ingredientId) ?? null}
              loadOptions={loadOptions}
              onSelect={(option) => updateItem(index, { ingredientId: option.id, name: option.label, unit: option.unit || item.unit || '份' })}
            />
            <label className="ai-resource-field ai-ingredient-quantity-field">
              <span>数量</span>
              <div className="ai-ingredient-quantity-control">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={item.quantity}
                  disabled={disabled}
                  aria-label={`${item.name}数量`}
                  onChange={(event) => updateItem(index, { quantity: Math.max(0.1, Number(event.target.value) || 1) })}
                />
                <input
                  type="text"
                  value={item.unit}
                  disabled={disabled}
                  aria-label={`${item.name}单位`}
                  onChange={(event) => updateItem(index, { unit: event.target.value })}
                />
              </div>
            </label>
            {!disabled && (
              <button className="ai-ingredient-remove-button" type="button" aria-label={`删除${item.name}`} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <SearchableResourceSelect
          kind="ingredient"
          label={items.length > 0 ? '添加食材' : '选择食材'}
          value=""
          placeholder="搜索食材库"
          disabled={false}
          selectedOption={null}
          loadOptions={loadOptions}
          excludeIds={Array.from(selectedIds)}
          onSelect={(option) => onChange([...items, { ingredientId: option.id, name: option.label, quantity: 1, unit: option.unit || '份' }])}
        />
      )}
    </section>
  );
}


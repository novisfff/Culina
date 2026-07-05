import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { buildUnitPresetOptions } from '../ingredients/ingredientWorkspaceForms';
import { asNumber, asText, draftNumberFromInput, draftNumberInputValue } from './aiDraftValueUtils';

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
  imageUrl?: string;
  unit?: string;
};

export type AiResourceOptionLoader = (
  kind: AiResourceKind,
  params: { query: string; offset: number; limit: number },
) => Promise<AiResourceOption[]>;

type MealPlanIngredientItem = {
  ingredientId: string;
  name: string;
  quantity: number | '';
  unit: string;
};

function unitPresetOptions(value: string) {
  return buildUnitPresetOptions(value).map((unit) => ({ value: unit, label: unit }));
}

function isPublicAssetImage(url?: string): url is string {
  return Boolean(url?.startsWith('/assets/'));
}

function ResourceThumbnail({ option }: { option?: AiResourceOption | null }) {
  const imageUrl = option?.imageUrl;
  if (isPublicAssetImage(imageUrl)) {
    return (
      <span className="ai-resource-thumbnail-frame">
        <img className="ai-resource-thumbnail" src={imageUrl} alt="" />
      </span>
    );
  }
  return (
    <MediaWithPlaceholder
      className="ai-resource-thumbnail-frame"
      imageClassName="ai-resource-thumbnail"
      src={imageUrl}
      alt=""
    />
  );
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
  icon?: 'calendar' | 'meal' | 'difficulty' | 'type' | 'step';
  className?: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const openMenu = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };
  const closeMenuSoon = () => {
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), 120);
  };
  const closeMenu = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(false);
  };
  const selectValue = (nextValue: string) => {
    onChange(nextValue);
    closeMenu();
  };

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <label className={`ai-resource-field ai-resource-field-choice ${className}`.trim()}>
      <span>{label}</span>
      <div className={`ai-resource-select ai-choice-select${isOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <ResourceSelectIcon kind={icon} />
        <button
          className="ai-single-select-trigger"
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onBlur={closeMenuSoon}
          onClick={() => {
            if (isOpen) {
              closeMenu();
            } else {
              openMenu();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openMenu();
            }
            if (event.key === 'Escape') {
              closeMenu();
            }
          }}
        >
          {selectedOption?.label ?? '请选择'}
        </button>
        <span className="ai-resource-select-chevron" aria-hidden="true" />
        {!disabled && isOpen && (
          <div className="ai-resource-menu ai-single-select-menu" role="listbox" onMouseDown={(event) => event.preventDefault()}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectValue(option.value)}
                >
                  <span className="ai-select-option-mark" aria-hidden="true" />
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

export function ApprovalComboboxField({
  label,
  value,
  disabled,
  options,
  placeholder,
  icon = 'type',
  allowCustom = true,
  className = '',
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
  icon?: 'calendar' | 'meal' | 'difficulty' | 'type' | 'step';
  allowCustom?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const closeTimerRef = useRef<number | null>(null);
  const normalizedQuery = normalizeSearchText(query);
  const normalizedValue = normalizeSearchText(value);
  const visibleOptions = options.filter((option) => {
    if (!normalizedQuery) return true;
    return normalizeSearchText(`${option.label} ${option.value} ${option.description ?? ''}`).includes(normalizedQuery);
  });
  const exactMatch = options.some((option) => normalizeSearchText(option.value) === normalizedValue || normalizeSearchText(option.label) === normalizedValue);
  const customValue = value.trim();
  const showCustom = allowCustom && customValue && !exactMatch;
  const openMenu = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setQuery('');
    setIsOpen(true);
  };
  const closeMenuSoon = () => {
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), 120);
  };
  const selectValue = (nextValue: string) => {
    onChange(nextValue);
    setQuery('');
    setIsOpen(false);
  };

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <label className={`ai-resource-field ai-resource-field-choice ai-resource-field-combobox ${className}`.trim()}>
      <span>{label}</span>
      <div className={`ai-resource-select ai-combobox-select${isOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <ResourceSelectIcon kind={icon} />
        <input
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? '请选择'}
          role="combobox"
          aria-expanded={isOpen}
          onFocus={openMenu}
          onBlur={closeMenuSoon}
          onChange={(event) => {
            if (closeTimerRef.current) {
              window.clearTimeout(closeTimerRef.current);
              closeTimerRef.current = null;
            }
            setQuery(event.target.value);
            onChange(event.target.value);
            setIsOpen(true);
          }}
        />
        <span className="ai-resource-select-chevron" aria-hidden="true" />
        {!disabled && isOpen && (
          <div className="ai-resource-menu ai-combobox-menu" role="listbox" onMouseDown={(event) => event.preventDefault()}>
            {visibleOptions.length > 0 && visibleOptions.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectValue(option.value)}
                >
                  <span className="ai-combobox-option-mark" aria-hidden="true" />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
            {showCustom && (
              <button
                type="button"
                className="ai-combobox-custom-option"
                role="option"
                aria-selected="false"
                onClick={() => selectValue(customValue)}
              >
                <span className="ai-combobox-option-mark is-custom" aria-hidden="true">＋</span>
                <span>
                  <strong>使用自定义：{customValue}</strong>
                  <small>确认后保存为本次草稿的字段值</small>
                </span>
              </button>
            )}
            {visibleOptions.length === 0 && !showCustom && (
              <p className="ai-resource-menu-state">没有匹配项</p>
            )}
          </div>
        )}
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
      quantity: draftNumberInputValue(record?.quantity, 1),
      unit: asText(record?.unit) || option?.unit || '份',
    }];
  });
}

function UnitComboboxInput({
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const closeTimerRef = useRef<number | null>(null);
  const options = useMemo(() => unitPresetOptions(''), []);
  const normalizedQuery = normalizeSearchText(query);
  const normalizedValue = normalizeSearchText(value);
  const visibleOptions = options.filter((option) => {
    if (!normalizedQuery) return true;
    return normalizeSearchText(`${option.label} ${option.value}`).includes(normalizedQuery);
  });
  const exactMatch = options.some((option) => normalizeSearchText(option.value) === normalizedValue);
  const customValue = value.trim();
  const showCustom = customValue && !exactMatch;
  const openMenu = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setQuery('');
    setIsOpen(true);
  };
  const closeMenuSoon = () => {
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), 120);
  };
  const selectValue = (nextValue: string) => {
    onChange(nextValue);
    setQuery('');
    setIsOpen(false);
  };

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <div className={`ai-ingredient-unit-combobox${isOpen ? ' is-open' : ''}`}>
      <input
        type="text"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={isOpen}
        onFocus={openMenu}
        onBlur={closeMenuSoon}
        onChange={(event) => {
          if (closeTimerRef.current) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
          }
          setQuery(event.target.value);
          onChange(event.target.value);
          setIsOpen(true);
        }}
      />
      {!disabled && isOpen && (
        <div className="ai-resource-menu ai-combobox-menu ai-ingredient-unit-menu" role="listbox" onMouseDown={(event) => event.preventDefault()}>
          {visibleOptions.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={selected ? 'is-selected' : ''}
                role="option"
                aria-selected={selected}
                onClick={() => selectValue(option.value)}
              >
                <span className="ai-combobox-option-mark" aria-hidden="true" />
                <span>
                  <strong>{option.label}</strong>
                </span>
              </button>
            );
          })}
          {showCustom && (
            <button
              type="button"
              className="ai-combobox-custom-option"
              role="option"
              aria-selected="false"
              onClick={() => selectValue(customValue)}
            >
              <span className="ai-combobox-option-mark is-custom" aria-hidden="true">＋</span>
              <span>
                <strong>使用自定义：{customValue}</strong>
              </span>
            </button>
          )}
          {visibleOptions.length === 0 && !showCustom && (
            <p className="ai-resource-menu-state">没有匹配项</p>
          )}
        </div>
      )}
    </div>
  );
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
                  value={draftNumberInputValue(item.quantity, 1)}
                  disabled={disabled}
                  aria-label={`${item.name}数量`}
                  onChange={(event) => updateItem(index, { quantity: draftNumberFromInput(event.target.value) })}
                />
                <UnitComboboxInput
                  value={item.unit}
                  disabled={disabled}
                  ariaLabel={`${item.name}单位`}
                  onChange={(unit) => updateItem(index, { unit })}
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

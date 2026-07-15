import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Food } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { SearchField } from '../../components/ui-kit';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS } from '../../lib/ui';
import {
  MEAL_COMPOSER_FOOD_TYPES,
  type MealComposerFood,
  type MealComposerFoodType,
} from './MealComposerModel';

const FOOD_TYPE_CHIP_LABELS: Record<MealComposerFoodType, string> = {
  selfMade: '家里做',
  takeout: '外卖',
  diningOut: '外食',
  readyMade: '买来即食',
};

export type MealFoodComboboxProps = {
  query: string;
  results: Food[];
  selectedFoods: MealComposerFood[];
  isSearching?: boolean;
  disabled?: boolean;
  className?: string;
  onQueryChange: (query: string) => void;
  onSelectExisting: (food: Food) => void;
  onCreateNew: (args: { name: string; type: MealComposerFoodType }) => void;
};

export function MealFoodCombobox(props: MealFoodComboboxProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const trimmedQuery = props.query.trim();
  const selectedExistingIds = useMemo(
    () =>
      new Set(
        props.selectedFoods
          .filter((food): food is Extract<MealComposerFood, { kind: 'existing' }> => food.kind === 'existing')
          .map((food) => food.food_id),
      ),
    [props.selectedFoods],
  );

  const availableResults = useMemo(
    () => props.results.filter((food) => !selectedExistingIds.has(food.id)),
    [props.results, selectedExistingIds],
  );

  const createActionIndex = availableResults.length;
  const optionCount = availableResults.length + (trimmedQuery ? 1 : 0);

  useEffect(() => {
    setHighlightIndex(0);
  }, [props.query, availableResults.length]);

  useEffect(() => {
    if (trimmedQuery.length > 0) {
      setMenuOpen(true);
    }
  }, [trimmedQuery]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpen]);

  function selectExisting(food: Food) {
    props.onSelectExisting(food);
    props.onQueryChange('');
    setPendingName(null);
    setMenuOpen(false);
  }

  function beginCreate(name: string) {
    const next = name.trim();
    if (!next) return;
    setPendingName(next);
    setMenuOpen(false);
  }

  function confirmCreate(type: MealComposerFoodType) {
    if (!pendingName) return;
    props.onCreateNew({ name: pendingName, type });
    props.onQueryChange('');
    setPendingName(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (menuOpen) {
        // Dismiss only the food menu; keep the composer open.
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        return;
      }
      if (pendingName) {
        event.preventDefault();
        event.stopPropagation();
        setPendingName(null);
      }
      return;
    }

    // While type chips are showing, Enter must not submit the outer form.
    if (pendingName) {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      setMenuOpen(true);
      return;
    }

    if (!menuOpen || optionCount === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((current) => (current + 1) % optionCount);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((current) => (current - 1 + optionCount) % optionCount);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (highlightIndex < availableResults.length) {
        const food = availableResults[highlightIndex];
        if (food) selectExisting(food);
        return;
      }
      if (trimmedQuery) {
        beginCreate(trimmedQuery);
      }
    }
  }

  return (
    <div
      className={['meal-composer-food-combobox', props.className].filter(Boolean).join(' ')}
      ref={rootRef}
    >
      <SearchField
        ariaLabel="搜索食物"
        placeholder="搜索家里的食物，或直接输入菜名"
        value={props.query}
        loading={props.isSearching}
        disabled={props.disabled}
        className="meal-composer-food-search"
        onChange={(value) => {
          props.onQueryChange(value);
          setPendingName(null);
          setMenuOpen(true);
        }}
        onFocus={() => setMenuOpen(true)}
        onClear={() => {
          props.onQueryChange('');
          setPendingName(null);
        }}
        onKeyDown={handleKeyDown}
      />

      {menuOpen && (trimmedQuery.length > 0 || availableResults.length > 0) ? (
        <div
          id={listboxId}
          className="meal-composer-food-menu"
          role="listbox"
          aria-label="食物搜索结果"
        >
          {props.isSearching && availableResults.length === 0 ? (
            <div className="meal-composer-food-menu-status" role="status">
              正在查找…
            </div>
          ) : null}

          {availableResults.map((food, index) => {
            const cover = food.images[0] ?? null;
            const selected = highlightIndex === index;
            return (
              <button
                key={food.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={
                  selected
                    ? 'meal-composer-food-option is-highlighted'
                    : 'meal-composer-food-option'
                }
                disabled={props.disabled}
                onMouseEnter={() => setHighlightIndex(index)}
                onClick={() => selectExisting(food)}
              >
                <span className="meal-composer-food-option-media">
                  <MediaWithPlaceholder
                    src={resolveMediaUrl(cover, 'thumb')}
                    srcSet={buildMediaSrcSet(cover)}
                    sizes={buildMediaSizes('thumb')}
                    alt=""
                    ariaHidden
                    showLabel={false}
                  />
                </span>
                <span className="meal-composer-food-option-copy">
                  <strong>{food.name}</strong>
                  <small>{FOOD_TYPE_LABELS[food.type] ?? food.type}</small>
                </span>
              </button>
            );
          })}

          {trimmedQuery ? (
            <button
              type="button"
              role="option"
              aria-selected={highlightIndex === createActionIndex}
              className={
                highlightIndex === createActionIndex
                  ? 'meal-composer-food-option meal-composer-food-create is-highlighted'
                  : 'meal-composer-food-option meal-composer-food-create'
              }
              disabled={props.disabled}
              onMouseEnter={() => setHighlightIndex(createActionIndex)}
              onClick={() => beginCreate(trimmedQuery)}
            >
              按‘{trimmedQuery}’记下
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingName ? (
        <div className="meal-composer-food-type-picker" role="group" aria-label="选择食物类型">
          <p className="meal-composer-food-type-prompt">“{pendingName}”是怎么来的？</p>
          <div className="meal-composer-food-type-chips">
            {MEAL_COMPOSER_FOOD_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="meal-composer-food-type-chip"
                disabled={props.disabled}
                onClick={() => confirmCreate(type)}
              >
                {FOOD_TYPE_CHIP_LABELS[type]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

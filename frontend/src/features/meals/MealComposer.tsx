import type { Food, MealLogCandidate, MealType, RecordMealTarget } from '../../api/types';
import {
  FormActions,
  TouchStepperField,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCandidateSelector } from './MealCandidateSelector';
import { MealFoodCombobox } from './MealFoodCombobox';
import {
  type MealComposerFood,
  type MealComposerFoodType,
} from './MealComposerModel';

const MEAL_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: MEAL_TYPE_LABELS.breakfast },
  { value: 'lunch', label: MEAL_TYPE_LABELS.lunch },
  { value: 'dinner', label: MEAL_TYPE_LABELS.dinner },
  { value: 'snack', label: MEAL_TYPE_LABELS.snack },
];

export type MealComposerProps = {
  open: boolean;
  date: string;
  mealType: MealType;
  dateOptions: string[];
  foods: MealComposerFood[];
  candidates: MealLogCandidate[];
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  target: RecordMealTarget;
  searchQuery: string;
  searchResults: Food[];
  isSearchingFoods?: boolean;
  busy?: boolean;
  error?: string | null;
  overlayRootClassName?: string;
  onClose: () => void;
  onDateChange: (date: string) => void;
  onMealTypeChange: (mealType: MealType) => void;
  onSearchQueryChange: (query: string) => void;
  onFoodsChange: (foods: MealComposerFood[]) => void;
  onTargetChange: (target: RecordMealTarget, selectedCandidateId?: string | null) => void;
  onSubmit: () => void;
};

function foodKey(food: MealComposerFood): string {
  return food.kind === 'existing' ? `existing:${food.food_id}` : `new:${food.client_food_id}`;
}

function createClientFoodId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tmp-${crypto.randomUUID()}`;
  }
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

export function MealComposer(props: MealComposerProps) {
  if (!props.open) {
    return null;
  }

  const busy = Boolean(props.busy);
  const formId = 'meal-composer-form';

  function closeIfAllowed() {
    if (!busy) {
      props.onClose();
    }
  }

  function updateFood(key: string, patch: Partial<MealComposerFood>) {
    props.onFoodsChange(
      props.foods.map((food) => (foodKey(food) === key ? ({ ...food, ...patch } as MealComposerFood) : food)),
    );
  }

  function removeFood(key: string) {
    props.onFoodsChange(props.foods.filter((food) => foodKey(food) !== key));
  }

  function selectExisting(food: Food) {
    if (props.foods.some((item) => item.kind === 'existing' && item.food_id === food.id)) {
      return;
    }
    props.onFoodsChange([
      ...props.foods,
      {
        kind: 'existing',
        food_id: food.id,
        name: food.name,
        servings: 1,
        cover: food.images[0] ?? null,
      },
    ]);
  }

  function createNew(args: { name: string; type: MealComposerFoodType }) {
    props.onFoodsChange([
      ...props.foods,
      {
        kind: 'new',
        client_food_id: createClientFoodId(),
        name: args.name.trim(),
        type: args.type,
        servings: 1,
      },
    ]);
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName ?? 'meal-composer-overlay-root'}
      onClose={closeIfAllowed}
      closeOnBackdrop={!busy}
      busy={busy}
    >
      <WorkspaceModal
        title="记一餐"
        description="选好吃了什么，点一下就记下"
        eyebrow="快速记录"
        className="meal-composer-modal"
        onClose={closeIfAllowed}
        busy={busy}
        footerActions={
          <FormActions
            className="meal-composer-actions"
            primaryLabel="记下这餐"
            primaryType="submit"
            primaryForm={formId}
            isSubmitting={busy}
            submittingLabel="正在记下..."
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form
          id={formId}
          className="meal-composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) {
              props.onSubmit();
            }
          }}
        >
          <div className="meal-composer-body">
            <section className="meal-composer-region meal-composer-main">
              <div className="meal-composer-field">
                <span>日期</span>
                <div className="meal-composer-date-strip" role="listbox" aria-label="选择日期">
                  {props.dateOptions.map((dateKey, index) => {
                    const parts = getDateParts(dateKey);
                    const label = index === 0 ? '今天' : index === 1 ? '明天' : parts.weekday;
                    return (
                      <button
                        key={dateKey}
                        type="button"
                        className={
                          props.date === dateKey
                            ? 'meal-composer-date-option is-active'
                            : 'meal-composer-date-option'
                        }
                        disabled={busy}
                        aria-selected={props.date === dateKey}
                        onClick={() => props.onDateChange(dateKey)}
                      >
                        <span>{label}</span>
                        <strong>
                          {parts.month}/{parts.day}
                        </strong>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="meal-composer-field">
                <span>餐次</span>
                <div className="meal-composer-segments" role="radiogroup" aria-label="选择餐次">
                  {MEAL_OPTIONS.map((meal) => (
                    <button
                      key={meal.value}
                      type="button"
                      role="radio"
                      aria-checked={props.mealType === meal.value}
                      className={
                        props.mealType === meal.value
                          ? 'meal-composer-segment is-active'
                          : 'meal-composer-segment'
                      }
                      disabled={busy}
                      onClick={() => props.onMealTypeChange(meal.value)}
                    >
                      {meal.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="meal-composer-field">
                <span>吃了什么</span>
                <MealFoodCombobox
                  query={props.searchQuery}
                  results={props.searchResults}
                  selectedFoods={props.foods}
                  isSearching={props.isSearchingFoods}
                  disabled={busy}
                  onQueryChange={props.onSearchQueryChange}
                  onSelectExisting={selectExisting}
                  onCreateNew={createNew}
                />
              </div>

              {props.foods.length > 0 ? (
                <ul className="meal-composer-food-list" aria-label="已选食物">
                  {props.foods.map((food) => {
                    const key = foodKey(food);
                    const cover = food.kind === 'existing' ? food.cover ?? null : null;
                    return (
                      <li key={key} className="meal-composer-food-item">
                        <span className="meal-composer-food-item-media">
                          <MediaWithPlaceholder
                            src={resolveMediaUrl(cover, 'thumb')}
                            srcSet={buildMediaSrcSet(cover)}
                            sizes={buildMediaSizes('thumb')}
                            alt=""
                            ariaHidden
                            showLabel={false}
                          />
                        </span>
                        <span className="meal-composer-food-item-copy">
                          <strong>{food.name}</strong>
                          {food.kind === 'new' ? <small>新建</small> : null}
                        </span>
                        <TouchStepperField
                          label={`${food.name}份量`}
                          value={food.servings}
                          min={0.5}
                          step={0.5}
                          disabled={busy}
                          className="meal-composer-servings"
                          onChange={(servings) => updateFood(key, { servings })}
                        />
                        <button
                          type="button"
                          className="meal-composer-food-remove"
                          disabled={busy}
                          aria-label={`移除${food.name}`}
                          onClick={() => removeFood(key)}
                        >
                          移除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="meal-composer-food-empty">先选一道菜，或直接按菜名记下</p>
              )}
            </section>

            <section className="meal-composer-region meal-composer-side">
              <MealCandidateSelector
                mode={props.candidateMode}
                mealType={props.mealType}
                candidates={props.candidates}
                selectedCandidateId={props.selectedCandidateId}
                target={props.target}
                draftFoods={props.foods}
                disabled={busy}
                onTargetChange={props.onTargetChange}
              />
            </section>
          </div>

          {props.error ? (
            <p className="meal-composer-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

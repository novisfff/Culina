import type { MealLogCandidate, MealType, MediaAsset, RecordMealTarget } from '../../api/types';
import {
  FormActions,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCandidateSelector } from './MealCandidateSelector';
import {
  getMealDateStripParts,
  mealDateStripLabel,
  type MealComposerFood,
} from './MealComposerModel';

const MEAL_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: MEAL_TYPE_LABELS.breakfast },
  { value: 'lunch', label: MEAL_TYPE_LABELS.lunch },
  { value: 'dinner', label: MEAL_TYPE_LABELS.dinner },
  { value: 'snack', label: MEAL_TYPE_LABELS.snack },
];

export type MealQuickRecordPrefilledFood = {
  food_id: string;
  name: string;
  cover?: MediaAsset | null;
  servings?: number;
};

export type MealQuickRecordViewProps = {
  open: boolean;
  prefilledFood: MealQuickRecordPrefilledFood;
  date: string;
  mealType: MealType;
  dateOptions: string[];
  candidates: MealLogCandidate[];
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  target: RecordMealTarget;
  busy?: boolean;
  error?: string | null;
  /** When true, date/mealType controls are fixed (plan-sourced complete). */
  slotLocked?: boolean;
  overlayRootClassName?: string;
  onClose: () => void;
  onDateChange: (date: string) => void;
  onMealTypeChange: (mealType: MealType) => void;
  onTargetChange: (target: RecordMealTarget, selectedCandidateId?: string | null) => void;
  onSubmit: () => void;
};

export function MealQuickRecordView(props: MealQuickRecordViewProps) {
  if (!props.open) {
    return null;
  }

  const busy = Boolean(props.busy);
  const slotLocked = Boolean(props.slotLocked);
  const controlsDisabled = busy || slotLocked;
  const formId = 'meal-quick-record-form';
  const draftFoods: MealComposerFood[] = [
    {
      kind: 'existing',
      food_id: props.prefilledFood.food_id,
      name: props.prefilledFood.name,
      servings: props.prefilledFood.servings ?? 1,
      cover: props.prefilledFood.cover ?? null,
    },
  ];
  const cover = props.prefilledFood.cover ?? null;

  function closeIfAllowed() {
    if (!busy) {
      props.onClose();
    }
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName ?? 'meal-quick-record-overlay-root'}
      onClose={closeIfAllowed}
      closeOnBackdrop={!busy}
      busy={busy}
    >
      <WorkspaceModal
        title="记到今天"
        description="确认日期和餐次，点一下就完成"
        eyebrow="快速记录"
        className="meal-quick-record-modal"
        onClose={closeIfAllowed}
        busy={busy}
        footerActions={
          <FormActions
            className="meal-quick-record-actions"
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
          className="meal-quick-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) {
              props.onSubmit();
            }
          }}
        >
          <div className="meal-quick-record-hero">
            <span className="meal-quick-record-cover">
              <MediaWithPlaceholder
                src={resolveMediaUrl(cover, 'card')}
                srcSet={buildMediaSrcSet(cover)}
                sizes={buildMediaSizes('thumb')}
                alt={cover?.alt?.trim() || props.prefilledFood.name}
              />
            </span>
            <span className="meal-quick-record-copy">
              <strong>{props.prefilledFood.name}</strong>
              <small>确认后记到这一餐</small>
            </span>
          </div>

          <div className="meal-quick-record-field">
            <span>日期</span>
            <div
              className="meal-quick-record-date-strip"
              role="listbox"
              aria-label="选择日期"
              aria-disabled={slotLocked || undefined}
            >
              {props.dateOptions.map((dateKey) => {
                const parts = getMealDateStripParts(dateKey);
                const label = mealDateStripLabel(dateKey);
                return (
                  <button
                    key={dateKey}
                    type="button"
                    className={
                      props.date === dateKey
                        ? 'meal-quick-record-date-option is-active'
                        : 'meal-quick-record-date-option'
                    }
                    disabled={controlsDisabled}
                    aria-selected={props.date === dateKey}
                    onClick={() => {
                      if (!controlsDisabled) {
                        props.onDateChange(dateKey);
                      }
                    }}
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

          <div className="meal-quick-record-field">
            <span>餐次</span>
            <div
              className="meal-quick-record-segments"
              role="radiogroup"
              aria-label="选择餐次"
              aria-disabled={slotLocked || undefined}
            >
              {MEAL_OPTIONS.map((meal) => (
                <button
                  key={meal.value}
                  type="button"
                  role="radio"
                  aria-checked={props.mealType === meal.value}
                  className={
                    props.mealType === meal.value
                      ? 'meal-quick-record-segment is-active'
                      : 'meal-quick-record-segment'
                  }
                  disabled={controlsDisabled}
                  onClick={() => {
                    if (!controlsDisabled) {
                      props.onMealTypeChange(meal.value);
                    }
                  }}
                >
                  {meal.label}
                </button>
              ))}
            </div>
          </div>

          <MealCandidateSelector
            mode={props.candidateMode}
            mealType={props.mealType}
            candidates={props.candidates}
            selectedCandidateId={props.selectedCandidateId}
            target={props.target}
            draftFoods={draftFoods}
            disabled={busy}
            className="meal-quick-record-candidates"
            onTargetChange={props.onTargetChange}
          />

          {props.error ? (
            <p className="meal-quick-record-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

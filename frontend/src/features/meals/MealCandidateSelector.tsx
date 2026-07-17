import type { MealLogCandidate, MealType, RecordMealTarget } from '../../api/types';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCover } from './MealCover';
import type { MealComposerFood } from './MealComposerModel';

export type MealCandidateSelectorProps = {
  mode: 'none' | 'single' | 'multi';
  mealType: MealType;
  candidates: MealLogCandidate[];
  selectedCandidateId: string | null;
  target: RecordMealTarget;
  draftFoods: MealComposerFood[];
  disabled?: boolean;
  className?: string;
  onTargetChange: (target: RecordMealTarget, selectedCandidateId?: string | null) => void;
};

function foodNames(foods: Array<{ name: string }>): string {
  return foods.map((food) => food.name).filter(Boolean).join('、');
}

function candidatePrompt(mealType: MealType): string {
  return mealType === 'snack' ? '要和这次加餐记在一起吗？' : '和今晚这顿一起记吗？';
}

function formatRecordedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

function finalCombinationNames(candidate: MealLogCandidate | null, draftFoods: MealComposerFood[]): string {
  const existing = candidate?.foods.map((food) => food.name) ?? [];
  const draft = draftFoods.map((food) => food.name);
  return [...existing, ...draft].filter(Boolean).join('、');
}

export function MealCandidateSelector(props: MealCandidateSelectorProps) {
  if (props.mode === 'none' || props.candidates.length === 0) {
    return null;
  }

  const className = ['meal-composer-candidates', props.className].filter(Boolean).join(' ');
  const existingTargetId = props.target.kind === 'existing' ? props.target.meal_log_id : null;
  const selected =
    props.candidates.find((item) => item.meal_log_id === props.selectedCandidateId) ??
    (existingTargetId
      ? props.candidates.find((item) => item.meal_log_id === existingTargetId)
      : null);
  const joiningExisting = props.target.kind === 'existing' && selected != null;
  const previewNames = finalCombinationNames(joiningExisting ? selected : null, props.draftFoods);

  if (props.mode === 'single') {
    const only = props.candidates[0]!;
    const names = foodNames(only.foods) || '已有记录';
    const mealPhoto = only.photo_count > 0 ? only.preview_media ?? null : null;
    const imageAlt = mealPhoto?.alt?.trim() || names;
    const isJoinSelected = props.target.kind === 'existing';

    return (
      <section className={className} aria-label="候选餐确认">
        <div className="meal-composer-candidate-single">
          <div className="meal-composer-candidate-copy">
            <strong>{candidatePrompt(props.mealType)}</strong>
            <span>{foodNames(only.foods) || '已有记录'}</span>
          </div>
          <span className="meal-composer-candidate-media">
            <MealCover
              alt={imageAlt}
              mealPhoto={mealPhoto}
              foods={only.foods.map((food) => ({
                id: food.food_id,
                name: food.name,
                cover: food.cover ?? null,
              }))}
            />
          </span>
          <div className="meal-composer-candidate-actions" role="group" aria-label="餐食记录方式">
            <button
              type="button"
              className={
                isJoinSelected
                  ? 'meal-composer-candidate-action is-selected'
                  : 'meal-composer-candidate-action'
              }
              disabled={props.disabled}
              aria-pressed={isJoinSelected}
              onClick={() =>
                props.onTargetChange(
                  {
                    kind: 'existing',
                    meal_log_id: only.meal_log_id,
                    expected_row_version: only.row_version,
                  },
                  only.meal_log_id,
                )
              }
            >
              <span className="meal-composer-candidate-action-indicator" aria-hidden="true" />
              <span>记在一起</span>
            </button>
            <button
              type="button"
              className={
                !isJoinSelected
                  ? 'meal-composer-candidate-action is-selected'
                  : 'meal-composer-candidate-action'
              }
              disabled={props.disabled}
              aria-pressed={!isJoinSelected}
              onClick={() => props.onTargetChange({ kind: 'new' }, null)}
            >
              <span className="meal-composer-candidate-action-indicator" aria-hidden="true" />
              <span>另记一顿</span>
            </button>
          </div>
        </div>
        {previewNames ? (
          <p className="meal-composer-final-preview">
            这顿会记成：{previewNames}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className={className} aria-label="选择候选餐">
      <div className="meal-composer-candidate-list" role="listbox" aria-label="候选餐列表">
        {props.candidates.map((item) => {
          const selectedItem = props.selectedCandidateId === item.meal_log_id && props.target.kind === 'existing';
          const names = foodNames(item.foods) || '已有记录';
          const mealPhoto = item.photo_count > 0 ? item.preview_media ?? null : null;
          return (
            <button
              key={item.meal_log_id}
              type="button"
              role="option"
              aria-selected={selectedItem}
              className={
                selectedItem
                  ? 'meal-composer-candidate-option is-selected'
                  : 'meal-composer-candidate-option'
              }
              disabled={props.disabled}
              onClick={() =>
                props.onTargetChange(
                  {
                    kind: 'existing',
                    meal_log_id: item.meal_log_id,
                    expected_row_version: item.row_version,
                  },
                  item.meal_log_id,
                )
              }
            >
              <span className="meal-composer-candidate-media">
                <MealCover
                  alt={mealPhoto?.alt?.trim() || names}
                  mealPhoto={mealPhoto}
                  foods={item.foods.map((food) => ({
                    id: food.food_id,
                    name: food.name,
                    cover: food.cover ?? null,
                  }))}
                />
              </span>
              <span className="meal-composer-candidate-option-copy">
                <strong>
                  {MEAL_TYPE_LABELS[item.meal_type]}
                  {formatRecordedAt(item.created_at) ? ` · ${formatRecordedAt(item.created_at)}` : ''}
                </strong>
                <span>{names}</span>
              </span>
              <span className="meal-composer-candidate-option-indicator" aria-hidden="true" />
            </button>
          );
        })}
        <button
          type="button"
          role="option"
          aria-label="另记一顿"
          aria-selected={props.target.kind === 'new'}
          className={
            props.target.kind === 'new'
              ? 'meal-composer-candidate-option meal-composer-candidate-new is-selected'
              : 'meal-composer-candidate-option meal-composer-candidate-new'
          }
          disabled={props.disabled}
          onClick={() => props.onTargetChange({ kind: 'new' }, null)}
        >
          <span className="meal-composer-candidate-option-copy">
            <strong>另记一顿</strong>
            <span>不合并到已有记录</span>
          </span>
          <span className="meal-composer-candidate-option-indicator" aria-hidden="true" />
        </button>
      </div>
      {previewNames ? (
        <p className="meal-composer-final-preview">
          这顿会记成：{previewNames}
        </p>
      ) : null}
    </section>
  );
}

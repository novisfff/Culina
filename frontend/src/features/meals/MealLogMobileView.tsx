import type { FormEventHandler } from 'react';
import type { Food, FoodPlanItem, MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { Badge } from '../../components/ui-kit';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import type { MealSource } from './MealLogEnrichment';
import { MealLogComposer, type LocalMealFoodEntry, type MealFormState } from './MealLogComposer';
import { buildMealTitle, formatMealTime, getMealIcon, getMealLogStatusLabel, getMealRatingSummary, getMealTone } from './MealLogWorkspaceModel';

type Props = {
  form: MealFormState;
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  entries: LocalMealFoodEntry[];
  selectedParticipants: string[];
  recentMeals: MealLog[];
  pendingMeals: MealLog[];
  selectedMeal: MealLog | null;
  mealSources: Map<string, MealSource>;
  isSubmitting: boolean;
  isUpdatingMeal: boolean;
  isGeneratingPhoto: boolean;
  showManualComposer: boolean;
  photoErrorMessage?: string | null;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onSelectMeal: (mealId: string) => void;
  onOpenMealRecord: (meal: MealLog) => void;
  onToggleManualComposer: () => void;
  onBackHome: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onFormChange: (form: MealFormState) => void;
  onToggleFood: (foodId: string, checked: boolean) => void;
  onUpdateFood: (foodId: string, key: 'servings' | 'note', value: string) => void;
  onUpdateParticipant: (userId: string, checked: boolean) => void;
  onUploadPhoto: (files: FileList | null) => void;
  onGeneratePhoto: (mode: 'reference' | 'text') => void;
  onResetPhoto: () => void;
};

export function MealLogMobileView(props: Props) {
  const visibleQueue = props.pendingMeals.length > 0 ? props.pendingMeals : props.recentMeals.slice(0, 4);

  return (
    <main className="mobile-log-page" aria-label="手机记录页">
      <div className="mobile-log-topbar">
        <div className="mobile-log-brand">
          <span className="mobile-log-logo" aria-hidden="true">
            记
          </span>
          <div>
            <strong>餐食记录</strong>
            <small>评价、照片和家人反馈</small>
          </div>
        </div>
        <div className="mobile-log-top-actions">
          <button type="button" className="mobile-log-anchor" onClick={props.onBackHome}>
            首页
          </button>
          <button
            type="button"
            className="mobile-log-anchor"
            onClick={() => document.getElementById('mobile-log-timeline')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          >
            时间线
          </button>
        </div>
      </div>

      <header className="mobile-log-hero">
        <div>
          <h1>今天吃得怎么样</h1>
          <p>菜单、手动补录和补充记录都在这里。</p>
        </div>
        <button type="button" className="mobile-log-primary-action" onClick={props.onToggleManualComposer}>
          {props.showManualComposer ? '收起补录' : '手动补录'}
        </button>
      </header>

      <section className="mobile-log-panel">
        <div className="mobile-log-section-head">
          <h2>待补充</h2>
          <span>{props.pendingMeals.length} 条</span>
        </div>
        <div className="mobile-log-queue">
          {visibleQueue.length > 0 ? (
            visibleQueue.map((meal) => (
              <button
                key={meal.id}
                type="button"
                className={props.selectedMeal?.id === meal.id ? 'mobile-log-queue-card active' : 'mobile-log-queue-card'}
                onClick={() => {
                  props.onSelectMeal(meal.id);
                  props.onOpenMealRecord(meal);
                }}
              >
                <span className={`mobile-log-meal-chip ${getMealTone(meal.meal_type)}`}>
                  <i>{getMealIcon(meal.meal_type)}</i>
                  {MEAL_TYPE_LABELS[meal.meal_type]}
                </span>
                <strong>{buildMealTitle(meal)}</strong>
                <small>{props.mealSources.get(meal.id)?.label ?? '手动补录'}</small>
                <em>补充记录</em>
              </button>
            ))
          ) : (
            <div className="mobile-log-empty">暂无待补充记录。</div>
          )}
        </div>
      </section>

      <section className="mobile-log-panel">
        <div className="mobile-log-section-head">
          <h2>手动补录</h2>
          <button type="button" onClick={props.onToggleManualComposer}>
            {props.showManualComposer ? '收起' : '补一餐'}
          </button>
        </div>
        {props.showManualComposer && (
          <MealLogComposer
            form={props.form}
            foods={props.foods}
            members={props.members}
            entries={props.entries}
            selectedParticipants={props.selectedParticipants}
            isSubmitting={props.isSubmitting}
            isGeneratingPhoto={props.isGeneratingPhoto}
            photoErrorMessage={props.photoErrorMessage}
            onSubmit={props.onSubmit}
            onFormChange={props.onFormChange}
            onToggleFood={props.onToggleFood}
            onUpdateFood={props.onUpdateFood}
            onUpdateParticipant={props.onUpdateParticipant}
            onUploadPhoto={props.onUploadPhoto}
            onGeneratePhoto={props.onGeneratePhoto}
            onResetPhoto={props.onResetPhoto}
          />
        )}
      </section>

      <section id="mobile-log-timeline" className="mobile-log-panel">
        <div className="mobile-log-section-head">
          <h2>最近记录</h2>
          <span>{props.recentMeals.length} 条</span>
        </div>
        {props.recentMeals.length > 0 ? (
          <div className="mobile-log-recent-list">
            {props.recentMeals.map((meal) => (
              <button
                key={meal.id}
                type="button"
                className={props.selectedMeal?.id === meal.id ? 'mobile-log-record-card active' : 'mobile-log-record-card'}
                onClick={() => {
                  props.onSelectMeal(meal.id);
                  props.onOpenMealRecord(meal);
                }}
              >
                <span className={`mobile-log-record-icon ${getMealTone(meal.meal_type)}`}>{getMealIcon(meal.meal_type)}</span>
                <div className="mobile-log-record-copy">
                  <div>
                    <span>{formatDate(meal.date)} · {formatMealTime(meal)}</span>
                    <Badge>{getMealLogStatusLabel(meal)}</Badge>
                  </div>
                  <strong>{buildMealTitle(meal)}</strong>
                  <p>{[props.mealSources.get(meal.id)?.label, getMealRatingSummary(meal), meal.notes.trim()].filter(Boolean).join(' · ') || '暂无评价和评论'}</p>
                  <small>{meal.participant_user_ids.length} 位参与 · {meal.photos.length} 张照片</small>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="mobile-log-empty">还没有最近记录。</div>
        )}
      </section>
    </main>
  );
}

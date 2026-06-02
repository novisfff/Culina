import type { FormEventHandler } from 'react';
import type { Food, FoodPlanItem, MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { Badge } from '../../components/ui-kit';
import { formatDate, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealEnrichmentForm, type MealSource, buildMealTitle, getMealRatingSummary, isMealLogEnriched } from './MealLogEnrichment';
import { MealLogComposer, type LocalMealFoodEntry, type MealFormState } from './MealLogComposer';

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
            <strong>今天吃了什么</strong>
            <small>随手记录一餐，库存建议会跟着更新</small>
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
        <h1>记录夹</h1>
        <p>从菜单生成待补充记录，吃完再补照片、评价和家人反馈。</p>
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
                onClick={() => props.onSelectMeal(meal.id)}
              >
                <span>{MEAL_TYPE_LABELS[meal.meal_type]}</span>
                <strong>{buildMealTitle(meal)}</strong>
                <small>{props.mealSources.get(meal.id)?.label ?? '手动补录'}</small>
              </button>
            ))
          ) : (
            <div className="mobile-log-empty">还没有待补充记录。从首页菜单标记已吃后，会自动出现在这里。</div>
          )}
        </div>
      </section>

      {props.selectedMeal && (
        <section className="mobile-log-panel mobile-log-enrichment-panel">
          <MealEnrichmentForm
            meal={props.selectedMeal}
            members={props.members}
            source={props.mealSources.get(props.selectedMeal.id) ?? { label: '手动补录', status: 'manual' }}
            isUpdating={props.isUpdatingMeal}
            updateMealLog={props.updateMealLog}
          />
        </section>
      )}

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
          <h2>餐食时间线</h2>
          <span>{props.recentMeals.length} 条</span>
        </div>
        {props.recentMeals.length > 0 ? (
          <div className="mobile-log-recent-list">
            {props.recentMeals.map((meal) => (
              <button key={meal.id} type="button" className="meal-card mobile-log-card" onClick={() => props.onSelectMeal(meal.id)}>
                <div className="inline-between">
                  <div>
                    <h3>
                      {formatDate(meal.date)} · {MEAL_TYPE_LABELS[meal.meal_type]}
                    </h3>
                    <p>{buildMealTitle(meal)}</p>
                  </div>
                  <Badge>{isMealLogEnriched(meal) ? '已补充' : '待补充'}</Badge>
                </div>
                <p className="subtle">{[getMealRatingSummary(meal), meal.notes].filter(Boolean).join(' · ') || '没有额外备注'}</p>
                <div className="mobile-log-meta">
                  <span>{formatDateTime(meal.created_at)}</span>
                  <span>{meal.participant_user_ids.length} 位参与</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="mobile-log-empty">还没有最近记录，先记下今天这顿饭。</div>
        )}
      </section>
    </main>
  );
}

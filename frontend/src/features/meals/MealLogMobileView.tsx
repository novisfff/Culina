import type { FormEventHandler } from 'react';
import type { Food, MealLog, Member } from '../../api/types';
import { Badge } from '../../components/ui-kit';
import { formatDate, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealLogComposer, type LocalMealFoodEntry, type MealFormState } from './MealLogComposer';

type Props = {
  form: MealFormState;
  foods: Food[];
  members: Member[];
  entries: LocalMealFoodEntry[];
  selectedParticipants: string[];
  recentMeals: MealLog[];
  isSubmitting: boolean;
  isGeneratingPhoto: boolean;
  photoErrorMessage?: string | null;
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
        <button
          type="button"
          className="mobile-log-anchor"
          onClick={() => document.getElementById('mobile-log-recent')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
        >
          最近记录
        </button>
      </div>

      <header className="mobile-log-hero">
        <h1>记录</h1>
        <p>支持多人参与、食物选择和餐食照片，外出也能快速补一笔。</p>
      </header>

      <section className="mobile-log-panel">
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
      </section>

      <section id="mobile-log-recent" className="mobile-log-panel">
        <div className="mobile-log-section-head">
          <h2>最近记录</h2>
          <span>{props.recentMeals.length} 条</span>
        </div>
        {props.recentMeals.length > 0 ? (
          <div className="mobile-log-recent-list">
            {props.recentMeals.map((meal) => (
              <article key={meal.id} className="meal-card mobile-log-card">
                <div className="inline-between">
                  <div>
                    <h3>
                      {formatDate(meal.date)} · {MEAL_TYPE_LABELS[meal.meal_type]}
                    </h3>
                    <p>{meal.food_entries.map((entry) => entry.food_name).join('、') || '未关联食物'}</p>
                  </div>
                  {meal.mood ? <Badge>{meal.mood}</Badge> : null}
                </div>
                <p className="subtle">{meal.notes || '没有额外备注'}</p>
                <div className="mobile-log-meta">
                  <span>{formatDateTime(meal.created_at)}</span>
                  <span>{meal.participant_user_ids.length} 位参与</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mobile-log-empty">还没有最近记录，先记下今天这顿饭。</div>
        )}
      </section>
    </main>
  );
}

import type { FormEventHandler } from 'react';
import type { Food, MealLog, Member } from '../../api/types';
import { Badge, PageHeader, SectionHeading } from '../../components/ui-kit';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealLogComposer, type LocalMealFoodEntry, type MealFormState } from './MealLogComposer';
import { MealLogMobileView } from './MealLogMobileView';

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

export function MealLogWorkspace(props: Props) {
  return (
    <>
      <MealLogMobileView {...props} />

      <main className="page-stack meal-log-desktop-view">
        <PageHeader
          variant="compact"
          eyebrow="记录"
          title="记录今天吃了什么"
          description="记录完成后，库存建议会跟着这顿饭一起留下。"
        />
        <div className="page-columns page-columns-split">
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

          <aside className="card page-section page-side-column">
            <SectionHeading title="最近记录" description="最近的餐食记录会持续保留在这里" />
            <div className="stack-list">
              {props.recentMeals.map((meal) => (
                <article key={meal.id} className="meal-card">
                  <div className="inline-between">
                    <div>
                      <h3>
                        {formatDate(meal.date)} · {MEAL_TYPE_LABELS[meal.meal_type]}
                      </h3>
                      <p>{meal.food_entries.map((entry) => entry.food_name).join('、')}</p>
                    </div>
                    <Badge>{meal.mood}</Badge>
                  </div>
                  <p className="subtle">{meal.notes || '没有额外备注'}</p>
                  {meal.deduction_suggestions.length > 0 && (
                    <div className="tag-row">
                      {meal.deduction_suggestions.map((item) => (
                        <Badge key={item.id}>
                          {item.ingredient_name} {item.suggested_amount}
                          {item.unit}
                        </Badge>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}

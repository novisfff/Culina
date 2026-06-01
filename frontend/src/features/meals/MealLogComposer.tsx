import type { FormEventHandler } from 'react';
import type { Food, ImageInputValue, MealType, Member } from '../../api/types';
import { ImageComposer, SectionHeading } from '../../components/ui-kit';
import { MEAL_TYPE_LABELS } from '../../lib/ui';

export type LocalMealFoodEntry = {
  food_id: string;
  servings: number;
  note: string;
};

export type MealFormState = {
  date: string;
  mealType: MealType;
  notes: string;
  mood: string;
  photos: ImageInputValue;
};

type MealLogComposerProps = {
  form: MealFormState;
  foods: Food[];
  members: Member[];
  entries: LocalMealFoodEntry[];
  selectedParticipants: string[];
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

export function MealLogComposer({
  form,
  foods,
  members,
  entries,
  selectedParticipants,
  isSubmitting,
  isGeneratingPhoto,
  photoErrorMessage,
  onSubmit,
  onFormChange,
  onToggleFood,
  onUpdateFood,
  onUpdateParticipant,
  onUploadPhoto,
  onGeneratePhoto,
  onResetPhoto,
}: MealLogComposerProps) {
  return (
    <section className="card page-section page-main-column">
      <SectionHeading title="新记录" description="支持多人参与、食物选择和图片上传" />
      <form className="form-grid" onSubmit={onSubmit}>
        <section className="form-panel-section span-two">
          <div className="section-mini-title">基础信息</div>
          <div className="form-grid nested-grid">
            <label>
              <span>日期</span>
              <input
                className="text-input"
                type="date"
                value={form.date}
                onChange={(event) => onFormChange({ ...form, date: event.target.value })}
              />
            </label>
            <label>
              <span>餐别</span>
              <select
                className="text-input"
                value={form.mealType}
                onChange={(event) => onFormChange({ ...form, mealType: event.target.value as MealType })}
              >
                {Object.entries(MEAL_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="form-panel-section span-two">
          <div className="section-mini-title">本餐食物</div>
          <div className="selection-list">
            {foods.map((food) => {
              const selected = entries.find((item) => item.food_id === food.id);
              return (
                <div key={food.id} className="selection-card">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={Boolean(selected)}
                      onChange={(event) => onToggleFood(food.id, event.target.checked)}
                    />
                    <span>{food.name}</span>
                  </label>
                  {selected && (
                    <div className="selection-details">
                      <input
                        className="text-input"
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={selected.servings}
                        onChange={(event) => onUpdateFood(food.id, 'servings', event.target.value)}
                      />
                      <input
                        className="text-input"
                        placeholder="这道菜的备注"
                        value={selected.note}
                        onChange={(event) => onUpdateFood(food.id, 'note', event.target.value)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="form-panel-section span-two">
          <div className="section-mini-title">共同就餐成员</div>
          <div className="member-row">
            {members.map((member) => (
              <label key={member.id} className="checkbox-row member-pill">
                <input
                  type="checkbox"
                  checked={selectedParticipants.includes(member.id)}
                  onChange={(event) => onUpdateParticipant(member.id, event.target.checked)}
                />
                <span>{member.display_name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="form-panel-section span-two">
          <div className="section-mini-title">补充信息</div>
          <div className="form-grid nested-grid">
            <label>
              <span>满意度</span>
              <input
                className="text-input"
                value={form.mood}
                onChange={(event) => onFormChange({ ...form, mood: event.target.value })}
              />
            </label>
            <label className="span-two">
              <span>备注</span>
              <textarea
                className="text-input"
                rows={3}
                value={form.notes}
                onChange={(event) => onFormChange({ ...form, notes: event.target.value })}
              />
            </label>
          </div>
        </section>

        <ImageComposer
          title="餐食照片"
          value={form.photos}
          previewLabel="餐食照片"
          onUpload={onUploadPhoto}
          onGenerate={onGeneratePhoto}
          onReset={onResetPhoto}
          isGenerating={isGeneratingPhoto}
          errorMessage={photoErrorMessage}
        />

        <div className="span-two form-actions">
          <button className="solid-button" type="submit" disabled={isSubmitting || isGeneratingPhoto}>
            {isSubmitting ? '保存中...' : isGeneratingPhoto ? '生成主图中...' : '保存餐食记录'}
          </button>
        </div>
      </form>
    </section>
  );
}

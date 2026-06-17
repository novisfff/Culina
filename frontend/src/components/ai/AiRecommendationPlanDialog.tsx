import { useEffect, useState, type FormEvent } from 'react';
import type { AiTodayRecommendationItem, CreateFoodPlanItemPayload, MealType } from '../../api/types';
import { todayKey } from '../../lib/date';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { ActionButton, WorkspaceModal } from '../ui-kit';
import { ResultImage } from './AiResultCards';

export type AiRecommendationPlanRequest = {
  recommendation: AiTodayRecommendationItem;
  messageId: string;
  partId: string;
  cardId: string;
  targetDate?: string | null;
  mealType?: MealType | null;
};

type Props = {
  request: AiRecommendationPlanRequest | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: CreateFoodPlanItemPayload) => Promise<void>;
};

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export function AiRecommendationPlanDialog({ request, isSubmitting, onClose, onSubmit }: Props) {
  const [planDate, setPlanDate] = useState(todayKey());
  const [mealType, setMealType] = useState<MealType>('dinner');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!request) return;
    setPlanDate(request.targetDate || todayKey());
    setMealType(request.mealType || 'dinner');
    setNote(`来自 AI 推荐：${request.recommendation.reason}`.slice(0, 255));
    setError('');
  }, [request]);

  if (!request) return null;
  const activeRequest = request;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const foodId = activeRequest.recommendation.foodId;
    if (!foodId) {
      setError('这条推荐还没有关联食物，暂时不能加入菜单计划。');
      return;
    }
    try {
      setError('');
      await onSubmit({
        food_id: foodId,
        plan_date: planDate,
        meal_type: mealType,
        note: note.trim(),
      });
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : '加入菜单计划失败，请稍后重试。');
    }
  }

  return (
    <div className="workspace-overlay-root ai-recommendation-plan-root">
      <div className="workspace-overlay-backdrop" onClick={isSubmitting ? undefined : onClose} />
      <WorkspaceModal
        title="加入菜单计划"
        description="日期和餐次已按你的提问预填，确认后写入家庭菜单。"
        eyebrow="AI 推荐"
        className="ai-recommendation-plan-modal"
        onClose={onClose}
      >
        <form className="ai-recommendation-plan-form" onSubmit={submit}>
          <div className="ai-recommendation-plan-food">
            <ResultImage asset={activeRequest.recommendation.image} alt={activeRequest.recommendation.name} />
            <div>
              <span>即将加入</span>
              <strong>{activeRequest.recommendation.name}</strong>
              <p>{activeRequest.recommendation.reason}</p>
            </div>
          </div>

          <div className="ai-recommendation-plan-fields">
            <label>
              <span>计划日期</span>
              <input
                className="text-input"
                type="date"
                min={todayKey()}
                value={planDate}
                onChange={(event) => setPlanDate(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>餐次</legend>
              <div className="ai-recommendation-meal-options">
                {MEAL_TYPES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={mealType === value ? 'active' : ''}
                    aria-pressed={mealType === value}
                    onClick={() => setMealType(value)}
                  >
                    {MEAL_TYPE_LABELS[value]}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <label className="ai-recommendation-plan-note">
            <span>备注</span>
            <input className="text-input" value={note} onChange={(event) => setNote(event.target.value)} />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="workspace-overlay-actions">
            <ActionButton tone="primary" type="submit" disabled={isSubmitting || !activeRequest.recommendation.foodId}>
              {isSubmitting ? '加入中...' : '确认加入'}
            </ActionButton>
            <ActionButton tone="secondary" type="button" disabled={isSubmitting} onClick={onClose}>
              取消
            </ActionButton>
          </div>
        </form>
      </WorkspaceModal>
    </div>
  );
}

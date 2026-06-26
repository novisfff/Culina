import type { FormEvent } from 'react';
import type { CookRecipePreviewResponse, MealType } from '../../api/types';
import { formatDate } from '../../lib/ui';
import { ActionButton, WorkspaceModal } from '../ui-kit';
import { MEAL_TYPE_OPTIONS } from './RecipeWorkspaceOptions';
import {
  formatCookPreviewRequestLabel,
  formatCookQuantity,
  formatCookShortageDetail,
  getCookPreviewActionLabel,
  type RecipeCookSessionState,
} from './RecipeWorkspaceModel';

type RecipeCookFinishDialogProps = {
  recipeTitle: string;
  cookPreview: CookRecipePreviewResponse | null;
  cookPreviewError: string | null;
  isCookPreviewLoading: boolean;
  session: RecipeCookSessionState;
  isCooking?: boolean;
  submitDisabled: boolean;
  onUpdateSession: (patch: Partial<RecipeCookSessionState>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function RecipeCookFinishDialog(props: RecipeCookFinishDialogProps) {
  const submitLabel = props.isCooking ? '处理中...' : getCookPreviewActionLabel(props.cookPreview?.preview_items);

  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title={`完成烹饪：${props.recipeTitle}`}
        description={props.cookPreview?.shortages.length ? '还有缺料，先加入采购或补齐库存后再确认。' : '确认本次份量、餐次和库存处理。'}
        eyebrow="完成确认"
        onClose={props.onClose}
        className="recipe-cook-finish-modal"
      >
        <form className="recipe-cook-finish-form" onSubmit={props.onSubmit}>
          <div className="recipe-cook-finish-preview">
            {props.isCookPreviewLoading ? (
              <p className="subtle">正在计算扣减预览...</p>
            ) : props.cookPreviewError ? (
              <article className="alert-card warning">
                <h3>预览暂不可用</h3>
                <p>{props.cookPreviewError}</p>
              </article>
            ) : props.cookPreview?.shortages.length ? (
              props.cookPreview.shortages.map((item) => (
                <article key={`${item.ingredient_name}-${item.unit}`} className="alert-card warning">
                  <h3>{item.ingredient_name}</h3>
                  <p>{formatCookShortageDetail(item)}</p>
                </article>
              ))
            ) : props.cookPreview?.preview_items.length ? (
              props.cookPreview.preview_items.map((item) => (
                <article key={`${item.ingredient_id}-${item.unit}`} className="recipe-cook-preview-row">
                  <div className="recipe-cook-preview-row-head">
                    <h3>{item.ingredient_name}</h3>
                    <span>{formatCookPreviewRequestLabel(item)}</span>
                  </div>
                  {item.deduction_note ? <p className="recipe-cook-preview-note">{item.deduction_note}</p> : null}
                  {item.batches.length > 0 ? (
                    <div className="recipe-cook-preview-batches">
                      {item.batches.map((batch) => (
                        <p key={batch.inventory_item_id}>
                          <strong>{formatCookQuantity(batch.quantity)}{batch.unit}</strong>
                          <span>{batch.storage_location}</span>
                          <span>{batch.expiry_date ? `到期 ${formatDate(batch.expiry_date)}` : '未设到期'}</span>
                        </p>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            ) : (
              <p className="subtle">当前菜谱没有需要扣减的库存项。</p>
            )}
          </div>
          <div className="form-grid compact-grid">
            <label>
              <span>本次份量</span>
              <input className="text-input" type="number" min="1" step="0.5" value={props.session.servings} onChange={(event) => props.onUpdateSession({ servings: event.target.value })} />
            </label>
            <label>
              <span>日期</span>
              <input className="text-input" type="date" value={props.session.date} onChange={(event) => props.onUpdateSession({ date: event.target.value })} />
            </label>
            <label>
              <span>餐次</span>
              <select className="text-input" value={props.session.mealType} onChange={(event) => props.onUpdateSession({ mealType: event.target.value as MealType })}>
                {MEAL_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label>
              <span>满意度</span>
              <select className="text-input" value={props.session.rating} onChange={(event) => props.onUpdateSession({ rating: event.target.value })}>
                <option value="">不评分</option>
                <option value="5">5 分</option>
                <option value="4">4 分</option>
                <option value="3">3 分</option>
                <option value="2">2 分</option>
                <option value="1">1 分</option>
              </select>
            </label>
          </div>
          <label className="checkbox-row checkbox-card">
            <input type="checkbox" checked={props.session.createMealLog} onChange={(event) => props.onUpdateSession({ createMealLog: event.target.checked })} />
            <span>同步生成餐食记录</span>
          </label>
          <label>
            <span>做法调整 / 变体</span>
            <textarea className="text-input" rows={2} value={props.session.adjustments} placeholder="例如：少放一勺油、番茄多炒 2 分钟出汁" onChange={(event) => props.onUpdateSession({ adjustments: event.target.value })} />
          </label>
          <label>
            <span>本次结果</span>
            <textarea className="text-input" rows={2} value={props.session.resultNote} placeholder="例如：孩子很喜欢，下次可以再少一点盐" onChange={(event) => props.onUpdateSession({ resultNote: event.target.value })} />
          </label>
          <div className="workspace-overlay-actions">
            <ActionButton tone="secondary" type="button" onClick={props.onClose}>继续做</ActionButton>
            <ActionButton tone="primary" type="submit" disabled={props.submitDisabled}>
              {submitLabel}
            </ActionButton>
          </div>
        </form>
      </WorkspaceModal>
    </div>
  );
}

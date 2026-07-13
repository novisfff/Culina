import { useState, type FormEvent, type ReactNode } from 'react';
import type { CookRecipePreviewItem, CookRecipePreviewResponse, CookRecipeShortage, MealType } from '../../api/types';
import { formatDate } from '../../lib/ui';
import { ActionButton, DropdownSelect, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { MEAL_TYPE_OPTIONS } from './RecipeWorkspaceOptions';
import {
  formatCookPreviewRequestLabel,
  formatCookQuantity,
  formatCookShortageDetail,
  getCookFinishStepStatus,
  getCookFinishStepStatusLabel,
  type CookFinishStepId,
  type RecipeCookSessionState,
} from './RecipeWorkspaceModel';

export type RecipeCookFinishSuccess = {
  message: string;
  mealLogId: string;
};

type RecipeCookFinishDialogProps = {
  recipeTitle: string;
  cookPreview: CookRecipePreviewResponse | null;
  cookPreviewError: string | null;
  isCookPreviewLoading: boolean;
  session: RecipeCookSessionState;
  isCooking?: boolean;
  submitDisabled: boolean;
  statusMessage?: string | null;
  success?: RecipeCookFinishSuccess | null;
  onUpdateSession: (patch: Partial<RecipeCookSessionState>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFinishAndReturn?: () => void;
  onViewMeal?: () => void;
};

const COOK_FINISH_STEPS: Array<{ id: CookFinishStepId; label: string; description: string }> = [
  { id: 'inventory', label: '库存核对', description: '确认份量和扣减预览' },
  { id: 'meal', label: '这餐的信息', description: '选择日期和餐次' },
  { id: 'feedback', label: '本次反馈', description: '留下评分、调整和结果' },
  { id: 'summary', label: '确认完成', description: '复核本次写入内容' },
];

function addUniqueStep(items: CookFinishStepId[], stepId: CookFinishStepId) {
  return items.includes(stepId) ? items : [...items, stepId];
}

function removeStep(items: CookFinishStepId[], stepId: CookFinishStepId) {
  return items.filter((item) => item !== stepId);
}

function PreviewItemsList(props: { items: CookRecipePreviewItem[] }) {
  if (props.items.length === 0) {
    return <p className="subtle">当前没有可扣减的库存批次。</p>;
  }

  return (
    <div className="recipe-cook-finish-list">
      {props.items.map((item) => (
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
      ))}
    </div>
  );
}

function ShortageList(props: { shortages: CookRecipeShortage[]; compact?: boolean }) {
  if (props.shortages.length === 0) return null;

  return (
    <div className={props.compact ? 'recipe-cook-finish-shortages compact' : 'recipe-cook-finish-shortages'}>
      {props.shortages.map((item) => (
        <article key={`${item.ingredient_id ?? item.ingredient_name}-${item.unit}`} className="alert-card warning">
          <h3>{item.ingredient_name}</h3>
          <p>{formatCookShortageDetail(item)}</p>
        </article>
      ))}
    </div>
  );
}

function StepPanel(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="recipe-cook-finish-step-panel">
      <div className="recipe-cook-finish-step-copy">
        <h4>{props.title}</h4>
        <p>{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

export function RecipeCookFinishDialog(props: RecipeCookFinishDialogProps) {
  const [activeStepId, setActiveStepId] = useState<CookFinishStepId>('inventory');
  const [completedStepIds, setCompletedStepIds] = useState<CookFinishStepId[]>([]);
  const [skippedStepIds, setSkippedStepIds] = useState<CookFinishStepId[]>([]);

  const activeStepIndex = COOK_FINISH_STEPS.findIndex((step) => step.id === activeStepId);
  const activeStep = COOK_FINISH_STEPS[activeStepIndex] ?? COOK_FINISH_STEPS[0];
  const isSummaryStep = activeStep.id === 'summary';
  const previewItems = props.cookPreview?.preview_items ?? [];
  const shortages = props.cookPreview?.shortages ?? [];
  const hasInventoryAttention = shortages.length > 0 || Boolean(props.cookPreviewError);
  const hasFeedback = Boolean(props.session.rating || props.session.adjustments.trim() || props.session.resultNote.trim());
  const isCooking = Boolean(props.isCooking);
  const success = props.success ?? null;

  function closeIfAllowed() {
    if (success) {
      props.onFinishAndReturn?.();
      return;
    }
    if (!isCooking) {
      props.onClose();
    }
  }

  function markCompleted(stepId: CookFinishStepId) {
    setCompletedStepIds((current) => addUniqueStep(current, stepId));
    setSkippedStepIds((current) => removeStep(current, stepId));
  }

  function markSkipped(stepId: CookFinishStepId) {
    setSkippedStepIds((current) => addUniqueStep(current, stepId));
    setCompletedStepIds((current) => removeStep(current, stepId));
  }

  function goNext() {
    markCompleted(activeStep.id);
    const nextStep = COOK_FINISH_STEPS[Math.min(activeStepIndex + 1, COOK_FINISH_STEPS.length - 1)];
    setActiveStepId(nextStep.id);
  }

  function skipCurrentStep() {
    if (activeStep.id !== 'feedback') return;
    markSkipped(activeStep.id);
    props.onUpdateSession({ rating: '', adjustments: '', resultNote: '' });
    const nextStep = COOK_FINISH_STEPS[Math.min(activeStepIndex + 1, COOK_FINISH_STEPS.length - 1)];
    setActiveStepId(nextStep.id);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!isSummaryStep) {
      event.preventDefault();
      goNext();
      return;
    }
    markCompleted('summary');
    props.onSubmit(event);
  }

  function renderInventoryStep() {
    return (
      <StepPanel
        title="先核对库存处理"
        description="确认本次份量后，系统会先扣减现有库存；缺少的部分只保留提醒，不阻止完成烹饪。"
      >
        <label className="recipe-cook-finish-field">
          <span>本次份量</span>
          <input
            className="text-input"
            type="number"
            min="1"
            step="0.5"
            value={props.session.servings}
            onChange={(event) => props.onUpdateSession({ servings: event.target.value })}
          />
        </label>
        <div className="recipe-cook-finish-preview">
          {props.isCookPreviewLoading ? (
            <p className="subtle">正在计算扣减预览...</p>
          ) : props.cookPreviewError ? (
            <article className="alert-card warning">
              <h3>预览暂不可用</h3>
              <p>{props.cookPreviewError}</p>
            </article>
          ) : (
            <>
              <PreviewItemsList items={previewItems} />
              <ShortageList shortages={shortages} />
            </>
          )}
        </div>
      </StepPanel>
    );
  }

  function renderMealStep() {
    return (
      <StepPanel
        title="填写这餐的信息"
        description="日期和餐次会用于本次做菜记录；完成后会自动记入吃过的。"
      >
        <div className="form-grid compact-grid">
          <label>
            <span>日期</span>
            <input className="text-input" type="date" value={props.session.date} onChange={(event) => props.onUpdateSession({ date: event.target.value })} />
          </label>
          <label>
            <span>餐次</span>
            <DropdownSelect
              ariaLabel="选择餐次"
              placeholder="选择餐次"
              value={props.session.mealType}
              options={MEAL_TYPE_OPTIONS}
              onChange={(mealType) => props.onUpdateSession({ mealType: mealType as MealType })}
            />
          </label>
        </div>
        <p className="subtle recipe-cook-finish-auto-record">完成后会自动记入吃过的</p>
      </StepPanel>
    );
  }

  function renderFeedbackStep() {
    return (
      <StepPanel
        title="补充这次做菜反馈"
        description="评分和备注都不是必填；跳过后只记录完成，不留下本次反馈。"
      >
        <label className="recipe-cook-finish-field">
          <span>满意度</span>
          <DropdownSelect
            ariaLabel="选择满意度"
            placeholder="不评分"
            value={props.session.rating}
            clearOption={{ value: '', label: '不评分' }}
            options={[
              { value: '5', label: '5 分' },
              { value: '4', label: '4 分' },
              { value: '3', label: '3 分' },
              { value: '2', label: '2 分' },
              { value: '1', label: '1 分' },
            ]}
            onChange={(rating) => props.onUpdateSession({ rating })}
          />
        </label>
        <label className="recipe-cook-finish-field">
          <span>做法调整 / 变体</span>
          <textarea className="text-input" rows={3} value={props.session.adjustments} placeholder="例如：少放一勺油、番茄多炒 2 分钟出汁" onChange={(event) => props.onUpdateSession({ adjustments: event.target.value })} />
        </label>
        <label className="recipe-cook-finish-field">
          <span>本次结果</span>
          <textarea className="text-input" rows={3} value={props.session.resultNote} placeholder="例如：孩子很喜欢，下次可以再少一点盐" onChange={(event) => props.onUpdateSession({ resultNote: event.target.value })} />
        </label>
      </StepPanel>
    );
  }

  function renderSummaryStep() {
    return (
      <StepPanel
        title="最后确认写入内容"
        description="确认后会记录这次烹饪，扣减可用库存；缺料项目会留作后续提醒。"
      >
        <div className="recipe-cook-finish-summary-grid">
          <article>
            <span>库存处理</span>
            <strong>{previewItems.length > 0 ? `将处理 ${previewItems.length} 项库存` : '没有可扣减库存'}</strong>
            <small>{shortages.length > 0 ? `${shortages.length} 项缺料会保留提醒` : '库存预览正常'}</small>
          </article>
          <article>
            <span>餐食记录</span>
            <strong>将生成 1 条餐食记录</strong>
            <small>{formatDate(props.session.date)} · {MEAL_TYPE_OPTIONS.find((item) => item.value === props.session.mealType)?.label ?? '晚餐'}</small>
          </article>
          <article>
            <span>本次反馈</span>
            <strong>{hasFeedback ? '本次反馈：已填写' : '本次反馈：未填写'}</strong>
            <small>{props.session.rating ? `${props.session.rating} 分` : '不评分'}</small>
          </article>
        </div>
        <PreviewItemsList items={previewItems} />
        <ShortageList shortages={shortages} compact />
      </StepPanel>
    );
  }

  function renderActiveStep() {
    if (activeStep.id === 'inventory') return renderInventoryStep();
    if (activeStep.id === 'meal') return renderMealStep();
    if (activeStep.id === 'feedback') return renderFeedbackStep();
    return renderSummaryStep();
  }

  const cookFinishFormId = 'recipe-cook-finish-form';
  const canSkip = activeStep.id === 'feedback';

  if (success) {
    return (
      <WorkspaceOverlayFrame
        rootClassName="recipe-workspace-overlay-root"
        onClose={() => props.onFinishAndReturn?.()}
        closeOnBackdrop
      >
        <WorkspaceModal
          title="烹饪完成"
          description={success.message}
          eyebrow="完成确认"
          onClose={() => props.onFinishAndReturn?.()}
          closeAriaLabel="关闭烹饪完成"
          className="recipe-cook-finish-modal"
          footerActions={
            <FormActions
              className="recipe-cook-finish-actions"
              primaryLabel="查看这餐"
              primaryType="button"
              onPrimary={() => props.onViewMeal?.()}
            >
              <ActionButton tone="secondary" type="button" onClick={() => props.onFinishAndReturn?.()}>
                完成并返回
              </ActionButton>
            </FormActions>
          }
        >
          <div className="recipe-cook-finish-success" role="status" aria-live="polite">
            <p>{success.message}</p>
          </div>
        </WorkspaceModal>
      </WorkspaceOverlayFrame>
    );
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName="recipe-workspace-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isCooking}
    >
      <WorkspaceModal
        title={`完成烹饪：${props.recipeTitle}`}
        description="按步骤核对本次写入内容；不想处理的步骤可以先跳过，确认前也能切回修改。"
        eyebrow="完成确认"
        onClose={closeIfAllowed}
        closeAriaLabel="关闭完成烹饪确认"
        className="recipe-cook-finish-modal"
        footerActions={
          <FormActions
            className="recipe-cook-finish-actions"
            primaryLabel={isSummaryStep ? '确认完成' : '下一步'}
            primaryType={isSummaryStep ? 'submit' : 'button'}
            primaryForm={isSummaryStep ? cookFinishFormId : undefined}
            primaryDisabled={isSummaryStep ? props.submitDisabled : false}
            isSubmitting={Boolean(isSummaryStep && isCooking)}
            onPrimary={isSummaryStep ? undefined : goNext}
          >
            <ActionButton tone="tertiary" type="button" onClick={closeIfAllowed} disabled={isCooking}>稍后处理</ActionButton>
            <ActionButton tone="secondary" type="button" onClick={() => setActiveStepId(COOK_FINISH_STEPS[Math.max(activeStepIndex - 1, 0)].id)} disabled={activeStepIndex <= 0 || isCooking}>
              上一步
            </ActionButton>
            {!isSummaryStep && canSkip ? (
              <ActionButton tone="secondary" type="button" onClick={skipCurrentStep} disabled={isCooking}>
                跳过此步
              </ActionButton>
            ) : null}
          </FormActions>
        }
      >
        <form id={cookFinishFormId} className="recipe-cook-finish-form" onSubmit={handleSubmit}>
          <div className="recipe-cook-finish-steps" role="tablist" aria-label="完成烹饪步骤">
            {COOK_FINISH_STEPS.map((step, index) => {
              const status = getCookFinishStepStatus({
                stepId: step.id,
                completedStepIds,
                skippedStepIds,
                hasInventoryAttention,
              });
              const isActive = step.id === activeStep.id;
              return (
                <button
                  key={step.id}
                  className={`recipe-cook-finish-step ${isActive ? 'active' : ''} status-${status}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  disabled={isCooking}
                  onClick={() => setActiveStepId(step.id)}
                >
                  <span>{index + 1}</span>
                  <strong>{step.label}</strong>
                  <small>{getCookFinishStepStatusLabel(status)}</small>
                </button>
              );
            })}
          </div>

          <div className="recipe-cook-finish-active-step" aria-live="polite">
            <p className="recipe-cook-finish-active-meta">{activeStep.label} · {activeStep.description}</p>
            {renderActiveStep()}
          </div>

          {props.statusMessage ? (
            <p className="recipe-cook-finish-status" role="status" aria-live="polite">
              {props.statusMessage}
            </p>
          ) : null}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

import type { CSSProperties, Dispatch, Ref, SetStateAction } from 'react';
import type { CookRecipePreviewResponse, RecipeStep } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, Badge } from '../ui-kit';
import { COOK_TIMER_PRESETS } from './RecipeWorkspaceOptions';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import {
  formatCookQuantity,
  formatCookTimer,
  formatCookTimerDuration,
  getRecipeStepIconName,
  getRecipeStepSummary,
  getRecipeStepTitle,
  type RecipeCookSessionState,
} from './RecipeWorkspaceModel';
import { DIFFICULTY_LABELS, type RecipeCardViewModel } from './workspaceModel';

type CookTimerPickerState = {
  minutes: number;
  seconds: number;
};

type RecipeCookViewProps = {
  activeCookCard: RecipeCardViewModel;
  cookSession: RecipeCookSessionState;
  cookSteps: RecipeStep[];
  currentCookStep: RecipeStep | null;
  currentStepSuggestedSeconds: number | null;
  cookTimerDisplaySeconds: number;
  cookTimerDurationSeconds: number | null;
  cookTimerProgress: number;
  cookProgressPercent: number;
  wasCookSessionRestored: boolean;
  cookPreview: CookRecipePreviewResponse | null;
  isCreatingShopping?: boolean;
  isCookTimerCustomOpen: boolean;
  cookTimerJustStarted: boolean;
  cookTimerPicker: CookTimerPickerState;
  cookTimerMinuteWheelRef: Ref<HTMLDivElement>;
  cookTimerSecondWheelRef: Ref<HTMLDivElement>;
  setCookTimerPicker: Dispatch<SetStateAction<CookTimerPickerState>>;
  setIsCookTimerCustomOpen: Dispatch<SetStateAction<boolean>>;
  exitCookMode: (target?: 'detail' | 'library') => void;
  jumpToCookStep: (index: number) => void;
  moveCookStep: (delta: number) => void;
  completeCurrentCookStepAndContinue: () => void;
  resetActiveCookSession: () => void;
  openShoppingDialog: (card: RecipeCardViewModel) => void;
  confirmCustomCookTimer: () => void;
  openCustomCookTimer: () => void;
  selectCookTimerDuration: (seconds: number | null) => void;
  resetCookTimer: () => void;
  toggleCookTimer: () => void;
  addCookTimerSeconds: (seconds: number) => void;
  toggleCookIngredient: (itemId: string) => void;
};

export function RecipeCookView({
  activeCookCard,
  cookSession,
  cookSteps,
  currentCookStep,
  currentStepSuggestedSeconds,
  cookTimerDisplaySeconds,
  cookTimerDurationSeconds,
  cookTimerProgress,
  cookProgressPercent,
  wasCookSessionRestored,
  cookPreview,
  isCreatingShopping,
  isCookTimerCustomOpen,
  cookTimerJustStarted,
  cookTimerPicker,
  cookTimerMinuteWheelRef,
  cookTimerSecondWheelRef,
  setCookTimerPicker,
  setIsCookTimerCustomOpen,
  exitCookMode,
  jumpToCookStep,
  moveCookStep,
  completeCurrentCookStepAndContinue,
  resetActiveCookSession,
  openShoppingDialog,
  confirmCustomCookTimer,
  openCustomCookTimer,
  selectCookTimerDuration,
  resetCookTimer,
  toggleCookTimer,
  addCookTimerSeconds,
  toggleCookIngredient,
}: RecipeCookViewProps) {
  return (
        <main className="recipe-cook-page">
          <section className="recipe-cook-hero-panel">
            <div className="recipe-cook-hero-copy">
              <button className="workspace-back-link" type="button" onClick={() => exitCookMode('detail')}>
                <span aria-hidden="true">‹</span>
                返回详情
              </button>
              <h2>{activeCookCard.recipe.title}</h2>
              <p>{activeCookCard.recipe.prep_minutes} 分钟 · {activeCookCard.recipe.servings} 人份 · {DIFFICULTY_LABELS[activeCookCard.recipe.difficulty]}</p>
            </div>
            <div className="recipe-cook-hero-side">
              <div className="recipe-cook-hero-art" aria-hidden="true">
                <MediaWithPlaceholder src={resolveAssetUrl(activeCookCard.coverUrl)} alt="" />
              </div>
              <div className="recipe-cook-progress-card">
                <Badge className={`recipe-availability-badge tone-${activeCookCard.availability}`}>{activeCookCard.availabilityLabel}</Badge>
                <strong>{cookProgressPercent}%</strong>
                <span>步骤 {cookSession.currentStepIndex + 1} / {cookSteps.length}</span>
                <ActionButton tone="secondary" type="button" onClick={() => exitCookMode('library')}>
                  退出烹饪
                </ActionButton>
              </div>
            </div>
          </section>

          <div className="recipe-cook-layout">
            <section className="recipe-cook-step-stage">
              <div className="recipe-cook-step-rail" aria-label="步骤进度">
                {cookSteps.map((step, index) => {
                  const isCurrent = index === cookSession.currentStepIndex;
                  const isDone = cookSession.completedStepIds.includes(step.id);
                  return (
                    <button
                      key={step.id}
                      className={`${isCurrent ? 'current ' : ''}${isDone ? 'done' : ''}`.trim()}
                      type="button"
                      onClick={() => jumpToCookStep(index)}
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      <span>{index + 1}</span>
                      <strong><RecipeUiIcon name={getRecipeStepIconName(step.icon)} />{getRecipeStepTitle(step, index)}</strong>
                    </button>
                  );
                })}
              </div>
              <div className="recipe-cook-step-count">
                <span>当前步骤</span>
                <strong>{cookSession.currentStepIndex + 1}</strong>
              </div>
              <article className={currentCookStep && cookSession.completedStepIds.includes(currentCookStep.id) ? 'recipe-cook-current-step done' : 'recipe-cook-current-step'}>
                <span className="recipe-cook-step-watermark">{String(cookSession.currentStepIndex + 1).padStart(2, '0')}</span>
                <div className="recipe-cook-step-board">
                  <div className="recipe-cook-current-step-copy">
                    <span className="recipe-cook-step-pill">当前步骤 {cookSession.currentStepIndex + 1} / {cookSteps.length}</span>
                    <h3>{getRecipeStepTitle(currentCookStep ?? {}, cookSession.currentStepIndex)}</h3>
                    <p>{currentCookStep?.text}</p>
                    <div className="recipe-cook-step-meta-grid">
                      <div>
                        <RecipeUiIcon name="clock" />
                        <span>预计用时</span>
                        <strong>{currentCookStep?.estimated_minutes ? `${currentCookStep.estimated_minutes} 分钟` : '按需调整'}</strong>
                      </div>
                      {currentCookStep?.tip ? (
                        <div>
                          <RecipeUiIcon name="sparkle" />
                          <span>烹饪小贴士</span>
                          <strong>{currentCookStep.tip}</strong>
                        </div>
                      ) : null}
                    </div>
                    {currentCookStep?.key_points?.length ? (
                      <div className="recipe-cook-key-points">
                        <strong>关键要点</strong>
                        {currentCookStep.key_points.map((point, index) => (
                          <span key={`${point}-${index}`}>{point}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="recipe-cook-step-overview" aria-label="烹饪顺序">
                    <div className="recipe-cook-step-overview-head">
                      <span>烹饪顺序</span>
                      <strong>{cookSession.currentStepIndex + 1} / {cookSteps.length}</strong>
                    </div>
                    <div className="recipe-cook-step-overview-list">
                      {cookSteps.map((step, index) => {
                        const isCurrent = index === cookSession.currentStepIndex;
                        const isDone = cookSession.completedStepIds.includes(step.id);
                        return (
                          <button
                            key={step.id}
                            className={`${isCurrent ? 'current ' : ''}${isDone ? 'done' : ''}`.trim()}
                            type="button"
                            onClick={() => jumpToCookStep(index)}
                            aria-current={isCurrent ? 'step' : undefined}
                          >
                            <span>{index + 1}</span>
                            <strong><RecipeUiIcon name={getRecipeStepIconName(step.icon)} />{getRecipeStepTitle(step, index)}</strong>
                            <small>{getRecipeStepSummary(step)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </article>
              <div className="recipe-cook-step-actions">
                <ActionButton tone="secondary" type="button" onClick={() => moveCookStep(-1)} disabled={cookSession.currentStepIndex <= 0}>
                  ‹ 上一步
                </ActionButton>
                <ActionButton tone="primary" type="button" onClick={completeCurrentCookStepAndContinue}>
                  {cookSession.currentStepIndex >= cookSteps.length - 1 ? '完成本步，完成烹饪' : '完成本步，进入下一步'}
                </ActionButton>
              </div>
            </section>

            <aside className="recipe-cook-side-panel">
              {(wasCookSessionRestored || Boolean(cookPreview?.shortages.length)) && (
                <section className="recipe-cook-status-card">
                  {wasCookSessionRestored && (
                    <div className="recipe-cook-status-row">
                      <span><RecipeUiIcon name="clock" /></span>
                      <div>
                        <strong>已恢复进度</strong>
                        <small>步骤、用料和计时已保存</small>
                      </div>
                      <button type="button" onClick={resetActiveCookSession}>重来</button>
                    </div>
                  )}
                  {cookPreview?.shortages.length ? (
                    <div className="recipe-cook-status-row warning">
                      <span><RecipeUiIcon name="warning" /></span>
                      <div>
                        <strong>缺 {cookPreview.shortages.length} 项</strong>
                        <small>{cookPreview.shortages.map((item) => `${item.ingredient_name} ${formatCookQuantity(item.missing_quantity)}${item.unit}`).join('、')}</small>
                      </div>
                      <button type="button" onClick={() => openShoppingDialog(activeCookCard)} disabled={isCreatingShopping}>采购</button>
                    </div>
                  ) : null}
                </section>
              )}
              <section className={`recipe-cook-timer-card ${cookSession.timerMode}${cookSession.timerRunning ? ' running' : ''}${cookTimerJustStarted ? ' started' : ''}${isCookTimerCustomOpen ? ' custom-open' : ''}`}>
                <div className="recipe-cook-timer-head">
                  <div>
                    <span>烹饪计时器</span>
                    <strong>{cookSession.timerMode === 'countdown' ? '倒计时' : '正计时'}</strong>
                  </div>
                  <small>{currentStepSuggestedSeconds ? `建议 ${formatCookTimerDuration(currentStepSuggestedSeconds)}` : '建议时长未设置'}</small>
                </div>
                {isCookTimerCustomOpen ? (
                  <div className="recipe-cook-time-picker-shell">
                    <div className="recipe-cook-time-picker" aria-label="自定义计时时长">
                      <div className="recipe-cook-time-picker-column">
                        <span>分钟</span>
                        <div className="recipe-cook-time-picker-wheel" ref={cookTimerMinuteWheelRef}>
                          {Array.from({ length: 60 }, (_, minute) => (
                            <button
                              key={minute}
                              className={cookTimerPicker.minutes === minute ? 'selected' : ''}
                              type="button"
                              onClick={() => setCookTimerPicker((current) => ({ ...current, minutes: minute }))}
                            >
                              {String(minute).padStart(2, '0')}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="recipe-cook-time-picker-separator">:</div>
                      <div className="recipe-cook-time-picker-column">
                        <span>秒</span>
                        <div className="recipe-cook-time-picker-wheel" ref={cookTimerSecondWheelRef}>
                          {Array.from({ length: 60 }, (_, second) => (
                            <button
                              key={second}
                              className={cookTimerPicker.seconds === second ? 'selected' : ''}
                              type="button"
                              onClick={() => setCookTimerPicker((current) => ({ ...current, seconds: second }))}
                            >
                              {String(second).padStart(2, '0')}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="recipe-cook-time-picker-preview">
                      <span>已选择</span>
                      <strong>{formatCookTimer(cookTimerPicker.minutes * 60 + cookTimerPicker.seconds)}</strong>
                    </div>
                    <div className="recipe-cook-timer-actions custom-actions">
                      <button type="button" onClick={() => setIsCookTimerCustomOpen(false)}>
                        取消
                      </button>
                      <button className="primary" type="button" onClick={confirmCustomCookTimer} disabled={cookTimerPicker.minutes === 0 && cookTimerPicker.seconds === 0}>
                        <RecipeUiIcon name="play" />
                        确定并开始
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="recipe-cook-timer-body">
                    <div className="recipe-cook-timer-presets" aria-label="计时时长">
                      {COOK_TIMER_PRESETS.map((preset) => {
                        const selected = preset.seconds === 'custom'
                          ? cookSession.timerMode === 'countdown' && Boolean(cookTimerDurationSeconds) && !COOK_TIMER_PRESETS.some((item) => typeof item.seconds === 'number' && item.seconds === cookTimerDurationSeconds)
                          : preset.seconds === null
                          ? cookSession.timerMode === 'countup'
                          : cookSession.timerMode === 'countdown' && cookTimerDurationSeconds === preset.seconds;
                        return (
                          <button
                            key={preset.label}
                            className={selected ? 'selected' : ''}
                            type="button"
                            disabled={cookSession.timerRunning}
                            onClick={() => (preset.seconds === 'custom' ? openCustomCookTimer() : selectCookTimerDuration(preset.seconds))}
                          >
                            {preset.seconds === 'custom' && selected ? formatCookTimer(cookTimerDurationSeconds ?? 0) : preset.label}
                          </button>
                        );
                      })}
                    </div>
                    <div
                      className="recipe-cook-timer-dial"
                      style={{ '--timer-progress': `${cookTimerProgress * 360}deg` } as CSSProperties}
                    >
                      <div>
                        <strong>{formatCookTimer(cookTimerDisplaySeconds)}</strong>
                        <span>{cookSession.timerMode === 'countdown' ? '剩余时间' : '已用时间'}</span>
                      </div>
                    </div>
                    <div className={`recipe-cook-timer-actions ${cookSession.timerMode === 'countdown' ? 'countdown' : 'countup'}`}>
                      <button type="button" onClick={resetCookTimer}>
                        <RecipeUiIcon name="reset" />
                        重置
                      </button>
                      <button className="primary" type="button" onClick={toggleCookTimer}>
                        <RecipeUiIcon name={cookSession.timerRunning ? 'pause' : 'play'} />
                        {cookSession.timerRunning ? '暂停' : '开始'}
                      </button>
                      {cookSession.timerMode === 'countdown' ? (
                        <button type="button" onClick={() => addCookTimerSeconds(30)}>
                          <RecipeUiIcon name="plusThirty" />
                          +30秒
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </section>

              <section className="recipe-cook-ingredients-card">
                <div className="recipe-cook-panel-head">
                  <h3>用料清单</h3>
                  <span>{cookSession.checkedIngredientIds.length} / {activeCookCard.recipe.ingredient_items.length}</span>
                </div>
                <div className="recipe-cook-ingredient-checklist">
                  {activeCookCard.recipe.ingredient_items.map((item) => {
                    const checked = cookSession.checkedIngredientIds.includes(item.id);
                    const availability = activeCookCard.ingredientAvailability.find((entry) => entry.item.id === item.id);
                    return (
                      <button key={item.id} className={checked ? 'checked' : ''} type="button" onClick={() => toggleCookIngredient(item.id)}>
                        <span>{checked ? <RecipeUiIcon name="check" /> : null}</span>
                        <strong>{item.ingredient_name}</strong>
                        <small className={availability?.ready ? 'ready' : availability ? 'missing' : ''}>
                          {item.quantity}{item.unit}{availability?.ready ? ' · 已备齐' : availability ? ` · 缺 ${availability.missingQuantity}${availability.unit}` : ''}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </section>
            </aside>
          </div>

          <div className="recipe-cook-bottom-bar">
            <ActionButton tone="secondary" type="button" onClick={() => moveCookStep(-1)} disabled={cookSession.currentStepIndex <= 0}>‹ 上一步</ActionButton>
            <ActionButton tone="primary" type="button" onClick={completeCurrentCookStepAndContinue}>
              {cookSession.currentStepIndex >= cookSteps.length - 1 ? '完成本步，完成烹饪' : '完成本步，进入下一步'}
            </ActionButton>
          </div>
        </main>

  );
}

import { useEffect, useState, type Dispatch, type Ref, type SetStateAction } from 'react';
import type { CookRecipePreviewResponse, RecipeStep } from '../../api/types';
import { ActionButton, WorkspaceModal } from '../ui-kit';
import { CookingAssistantPanel } from './CookingAssistantPanel';
import { COOK_TIMER_PRESETS } from './RecipeWorkspaceOptions';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import {
  formatCookQuantity,
  formatCookShortageSummary,
  formatCookTimer,
  formatCookTimerDuration,
  getRecipeStepIconName,
  getRecipeStepSummary,
  getRecipeStepTitle,
  type RecipeCookAssistantMessage,
  type RecipeCookSessionState,
  type CookTimerState,
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
  openCookFinishDialog: () => void;
  openShoppingDialog: (card: RecipeCardViewModel) => void;
  confirmCustomCookTimer: () => void;
  openCustomCookTimer: () => void;
  selectCookTimerDuration: (seconds: number | null) => void;
  resetCookTimer: () => void;
  toggleCookTimer: () => void;
  addCookTimerSeconds: (seconds: number) => void;
  toggleCookIngredient: (itemId: string) => void;
  timers: CookTimerState[];
  activeTimerId: string;
  addTimer: (mode: 'countup' | 'countdown', durationSeconds: number | null, name?: string) => void;
  deleteTimer: (id: string) => void;
  selectTimer: (id: string) => void;
  toggleTimerById: (id: string) => void;
  startTimerById: (id?: string) => void;
  pauseTimerById: (id?: string) => void;
  resetTimerById: (id?: string) => void;
  addTimerSecondsById: (id: string | undefined, seconds: number) => void;
  setTimerById: (id: string | undefined, seconds: number, name?: string) => void;
  setCookAssistantMessages: (messages: RecipeCookAssistantMessage[]) => void;
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
  openCookFinishDialog,
  openShoppingDialog,
  confirmCustomCookTimer,
  openCustomCookTimer,
  selectCookTimerDuration,
  resetCookTimer,
  toggleCookTimer,
  addCookTimerSeconds,
  toggleCookIngredient,
  timers,
  activeTimerId,
  addTimer,
  deleteTimer,
  selectTimer,
  startTimerById,
  pauseTimerById,
  resetTimerById,
  addTimerSecondsById,
  setTimerById,
  setCookAssistantMessages,
}: RecipeCookViewProps) {
  const [activeSidebarTab, setActiveSidebarTab] = useState<'ingredients' | 'steps'>('ingredients');
  const [deletingTimerId, setDeletingTimerId] = useState<string | null>(null);
  const [activeMobileTab, setActiveMobileTab] = useState<'step' | 'ingredients'>('step');
  const [pendingExitTarget, setPendingExitTarget] = useState<'detail' | 'library' | null>(null);

  useEffect(() => {
    setActiveMobileTab('step');
  }, [cookSession.currentStepIndex]);

  const activeTimer = timers.find((t) => t.id === activeTimerId) ?? timers[0] ?? null;
  const isFinished = activeTimer && activeTimer.mode === 'countdown' && activeTimer.durationSeconds && activeTimer.seconds >= activeTimer.durationSeconds;

  const runningTimers = timers.filter((t) => t.running);
  const finishedTimers = timers.filter((t) => t.mode === 'countdown' && t.durationSeconds && t.seconds >= t.durationSeconds);
  let stepTabSuffix = '';
  if (finishedTimers.length > 0) {
    stepTabSuffix = ' (已完成 🔔)';
  } else if (runningTimers.length > 0) {
    const firstRunning = runningTimers[0];
    const remaining = firstRunning.mode === 'countdown' ? Math.max((firstRunning.durationSeconds ?? 0) - firstRunning.seconds, 0) : firstRunning.seconds;
    stepTabSuffix = ` (${formatCookTimer(remaining)})`;
  }

  function requestCookExit(target: 'detail' | 'library') {
    if (runningTimers.length > 0) {
      setPendingExitTarget(target);
      return;
    }
    exitCookMode(target);
  }

  return (
    <main className={`recipe-cook-page mobile-tab-${activeMobileTab}`}>
      <header className="recipe-cook-header">
        <button className="workspace-back-link" type="button" onClick={() => requestCookExit('detail')}>
          <span aria-hidden="true">‹</span>
          返回详情
        </button>
        <div className="recipe-cook-header-title">
          <h2>{activeCookCard.recipe.title}</h2>
          <p>{activeCookCard.recipe.prep_minutes} 分钟 · {activeCookCard.recipe.servings} 人份 · {DIFFICULTY_LABELS[activeCookCard.recipe.difficulty]}</p>
        </div>
        <div className="recipe-cook-header-progress">
          <div className="recipe-cook-progress-track">
            <span style={{ width: `${cookProgressPercent}%` }} />
          </div>
          <span>步骤 {cookSession.currentStepIndex + 1} / {cookSteps.length} ({cookProgressPercent}%)</span>
        </div>
        <ActionButton tone="secondary" type="button" onClick={() => requestCookExit('library')}>
          退出烹饪
        </ActionButton>
      </header>

      <div className="recipe-cook-mobile-nav" role="tablist" aria-label="移动端视图分段">
        <button
          className={`recipe-cook-mobile-tab ${activeMobileTab === 'step' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeMobileTab === 'step'}
          onClick={() => setActiveMobileTab('step')}
        >
          步骤详情{stepTabSuffix}
        </button>
        <button
          className={`recipe-cook-mobile-tab ${activeMobileTab === 'ingredients' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeMobileTab === 'ingredients'}
          onClick={() => {
            setActiveSidebarTab('ingredients');
            setActiveMobileTab('ingredients');
          }}
        >
          食材清单
        </button>
      </div>

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

          <article className={currentCookStep && cookSession.completedStepIds.includes(currentCookStep.id) ? 'recipe-cook-current-step done' : 'recipe-cook-current-step'}>
            <span className="recipe-cook-step-watermark">{String(cookSession.currentStepIndex + 1).padStart(2, '0')}</span>
            <div className="recipe-cook-step-content">
              <div className="recipe-cook-current-step-copy">
                <span className="recipe-cook-step-pill">步骤 {cookSession.currentStepIndex + 1} / {cookSteps.length}</span>
                <h3>{getRecipeStepTitle(currentCookStep ?? {}, cookSession.currentStepIndex)}</h3>
                <p className="recipe-cook-instruction-text">{currentCookStep?.text}</p>

                <div className="recipe-cook-step-meta-grid">
                  <div className="recipe-cook-meta-item">
                    <RecipeUiIcon name="clock" />
                    <div className="meta-copy">
                      <span>预计用时</span>
                      <strong>{currentCookStep?.estimated_minutes ? `${currentCookStep.estimated_minutes} 分钟` : '按需调整'}</strong>
                    </div>
                  </div>
                  {currentCookStep?.tip ? (
                    <div className="recipe-cook-meta-item tip">
                      <RecipeUiIcon name="sparkle" />
                      <div className="meta-copy">
                        <span>烹饪小贴士</span>
                        <strong>{currentCookStep.tip}</strong>
                      </div>
                    </div>
                  ) : null}
                </div>

                {currentCookStep?.key_points?.length ? (
                  <div className="recipe-cook-key-points">
                    <strong>关键要点</strong>
                    <div className="key-points-list">
                      {currentCookStep.key_points.map((point, index) => (
                        <span key={`${point}-${index}`}>{point}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </article>

          <div className="recipe-cook-step-actions mobile-only-actions">
            <ActionButton tone="secondary" type="button" onClick={() => moveCookStep(-1)} disabled={cookSession.currentStepIndex <= 0}>
              ‹ 上一步
            </ActionButton>
            <ActionButton tone="primary" type="button" onClick={completeCurrentCookStepAndContinue}>
              {cookSession.currentStepIndex >= cookSteps.length - 1 ? '完成本步，完成烹饪' : '完成本步，进入下一步'}
            </ActionButton>
          </div>

          <div className="recipe-cook-step-actions desktop-only-actions">
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
            <section className="recipe-cook-status-card recipe-cook-status-desktop">
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
                    <small>{cookPreview.shortages.map(formatCookShortageSummary).join('、')}</small>
                  </div>
                  <button type="button" onClick={() => openShoppingDialog(activeCookCard)} disabled={isCreatingShopping}>采购</button>
                </div>
              ) : null}
            </section>
          )}

          {cookPreview?.shortages.length ? (
            <section className="recipe-cook-status-card recipe-cook-status-mobile recipe-cook-shortage-status">
              <div className="recipe-cook-status-row warning">
                <span><RecipeUiIcon name="warning" /></span>
                <div>
                  <strong>还缺 {cookPreview.shortages.length} 项食材</strong>
                  <small>{cookPreview.shortages.map(formatCookShortageSummary).join('、')}</small>
                </div>
                <button type="button" onClick={() => openShoppingDialog(activeCookCard)} disabled={isCreatingShopping}>
                  去采购
                </button>
              </div>
            </section>
          ) : null}

          <section className={`recipe-cook-timer-card ${activeTimer?.mode || 'countup'}${activeTimer?.running ? ' running' : ''}${cookTimerJustStarted ? ' started' : ''}${isCookTimerCustomOpen ? ' custom-open' : ''}${isFinished ? ' finished' : ''}`}>
            <div className="recipe-cook-timer-head">
              <div>
                <span className="recipe-cook-timer-title-span">
                  <RecipeUiIcon name="clock" className="timer-head-icon" />
                  烹饪计时器
                </span>
                <strong>{activeTimer?.mode === 'countdown' ? '倒计时' : '正计时'}</strong>
              </div>
              <small>{currentStepSuggestedSeconds ? `建议 ${formatCookTimerDuration(currentStepSuggestedSeconds)}` : '建议时长未设置'}</small>
            </div>

            <div className="recipe-cook-timer-tabs" role="tablist">
              {timers.map((timer) => {
                const isActive = timer.id === activeTimerId;
                const remaining = timer.mode === 'countdown' ? Math.max((timer.durationSeconds ?? 0) - timer.seconds, 0) : timer.seconds;
                const isTimerFinished = timer.mode === 'countdown' && timer.durationSeconds && timer.seconds >= timer.durationSeconds;
                return (
                  <div
                    key={timer.id}
                    className={`recipe-cook-timer-tab-wrapper ${isActive ? 'active' : ''} ${timer.running ? 'running' : ''} ${isTimerFinished ? 'finished' : ''}`}
                  >
                    <button
                      className="recipe-cook-timer-tab-btn"
                      type="button"
                      onClick={() => selectTimer(timer.id)}
                      role="tab"
                      aria-selected={isActive}
                    >
                      <span className="timer-tab-name">{timer.name}</span>
                      <strong className="timer-tab-time">{formatCookTimer(remaining)}</strong>
                    </button>
                    {timers.length > 1 && (
                      <button
                        className="timer-tab-delete-btn"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (timer.running) {
                            setDeletingTimerId(timer.id);
                          } else {
                            deleteTimer(timer.id);
                          }
                        }}
                        aria-label="删除计时器"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                className="recipe-cook-timer-add-tab"
                type="button"
                onClick={() => addTimer('countup', null)}
                aria-label="新增计时器"
              >
                +
              </button>
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
                      ? activeTimer?.mode === 'countdown' && Boolean(cookTimerDurationSeconds) && !COOK_TIMER_PRESETS.some((item) => typeof item.seconds === 'number' && item.seconds === cookTimerDurationSeconds)
                      : preset.seconds === null
                      ? activeTimer?.mode === 'countup'
                      : activeTimer?.mode === 'countdown' && cookTimerDurationSeconds === preset.seconds;
                    return (
                      <button
                        key={preset.label}
                        className={selected ? 'selected' : ''}
                        type="button"
                        disabled={activeTimer?.running}
                        onClick={() => (preset.seconds === 'custom' ? openCustomCookTimer() : selectCookTimerDuration(preset.seconds))}
                      >
                        {preset.seconds === 'custom' && selected ? formatCookTimer(cookTimerDurationSeconds ?? 0) : preset.label}
                      </button>
                    );
                  })}
                </div>

                <div className="recipe-cook-timer-clock-display" key={activeTimerId}>
                  <div className="recipe-cook-timer-clock-inner">
                    <span className="recipe-cook-timer-clock-digits">
                      {formatCookTimer(cookTimerDisplaySeconds)}
                    </span>
                    <span className="recipe-cook-timer-clock-label">
                      {isFinished ? '时间到！' : activeTimer?.mode === 'countdown' ? '剩余时间' : '已用时间'}
                    </span>
                  </div>
                </div>

                <div className={`recipe-cook-timer-actions ${activeTimer?.mode === 'countdown' ? 'countdown' : 'countup'}`}>
                  <button type="button" onClick={resetCookTimer}>
                    <RecipeUiIcon name="reset" />
                    重置
                  </button>
                  <button className="primary" type="button" onClick={toggleCookTimer}>
                    <RecipeUiIcon name={activeTimer?.running ? 'pause' : 'play'} />
                    {activeTimer?.running ? '暂停' : '开始'}
                  </button>
                  {activeTimer?.mode === 'countdown' ? (
                    <button type="button" onClick={() => addCookTimerSeconds(30)}>
                      <RecipeUiIcon name="plusThirty" />
                      +30秒
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </section>

          <section className="recipe-cook-tabs-card">
            <div className="recipe-cook-tabs-header" role="tablist">
              <button
                className={`recipe-cook-tab-btn ${activeSidebarTab === 'ingredients' ? 'active' : ''}`}
                type="button"
                role="tab"
                aria-selected={activeSidebarTab === 'ingredients'}
                onClick={() => setActiveSidebarTab('ingredients')}
              >
                用料清单 ({cookSession.checkedIngredientIds.length}/{activeCookCard.recipe.ingredient_items.length})
              </button>
              <button
                className={`recipe-cook-tab-btn ${activeSidebarTab === 'steps' ? 'active' : ''}`}
                type="button"
                role="tab"
                aria-selected={activeSidebarTab === 'steps'}
                onClick={() => setActiveSidebarTab('steps')}
              >
                全部步骤 ({cookSteps.length})
              </button>
            </div>

            <div className="recipe-cook-tab-content">
              {activeSidebarTab === 'ingredients' ? (
                <div className="recipe-cook-ingredient-checklist">
                  {activeCookCard.recipe.ingredient_items.map((item) => {
                    const checked = cookSession.checkedIngredientIds.includes(item.id);
                    const availability = activeCookCard.ingredientAvailability.find((entry) => entry.item.id === item.id);
                    return (
                      <button key={item.id} className={checked ? 'checked' : ''} type="button" onClick={() => toggleCookIngredient(item.id)}>
                        <span className="checklist-box">{checked ? <RecipeUiIcon name="check" /> : null}</span>
                        <strong>{item.ingredient_name}</strong>
                        <small className={availability?.ready ? 'ready' : availability ? 'missing' : ''}>
                          {item.quantity}{item.unit}{availability?.ready ? ' · 已备齐' : availability ? ` · 缺 ${availability.missingQuantity}${availability.unit}` : ''}
                        </small>
                      </button>
                    );
                  })}
                </div>
              ) : (
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
                        <div className="step-overview-item-body">
                          <strong><RecipeUiIcon name={getRecipeStepIconName(step.icon)} />{getRecipeStepTitle(step, index)}</strong>
                          <small>{getRecipeStepSummary(step)}</small>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {wasCookSessionRestored ? (
            <section className="recipe-cook-status-card recipe-cook-status-mobile recipe-cook-restored-status">
              <div className="recipe-cook-status-row">
                <span><RecipeUiIcon name="clock" /></span>
                <div>
                  <strong>已恢复上次进度</strong>
                  <small>步骤、用料和计时均已保存</small>
                </div>
                <button type="button" onClick={resetActiveCookSession}>重新开始</button>
              </div>
            </section>
          ) : null}

          <CookingAssistantPanel
            activeCookCard={activeCookCard}
            cookSession={cookSession}
            cookSteps={cookSteps}
            currentCookStep={currentCookStep}
            cookPreview={cookPreview}
            timers={timers}
            activeTimerId={activeTimerId}
            activeMobileTab={activeMobileTab}
            onMessagesChange={setCookAssistantMessages}
            actions={{
              goNextStep: completeCurrentCookStepAndContinue,
              goPreviousStep: () => moveCookStep(-1),
              jumpToStep: jumpToCookStep,
              switchTab: (tab) => {
                if (tab === 'ingredients') {
                  setActiveSidebarTab('ingredients');
                }
                setActiveMobileTab(tab);
              },
              startTimer: startTimerById,
              pauseTimer: pauseTimerById,
              resetTimer: resetTimerById,
              addTimerSeconds: addTimerSecondsById,
              setTimer: setTimerById,
              resetCookSession: resetActiveCookSession,
              deleteTimer,
              finishCooking: openCookFinishDialog,
              openShoppingDialog: () => openShoppingDialog(activeCookCard),
            }}
          />
        </aside>
      </div>

      {pendingExitTarget && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setPendingExitTarget(null)} />
          <WorkspaceModal
            title={pendingExitTarget === 'detail' ? '暂停计时并返回详情？' : '暂停计时并退出烹饪？'}
            description={`当前有 ${runningTimers.length} 个计时器正在工作。退出后会暂停计时，烹饪步骤和已用时间仍会保留。`}
            eyebrow="计时提醒"
            onClose={() => setPendingExitTarget(null)}
            closeAriaLabel="关闭退出提醒"
            className="recipe-cook-exit-modal"
          >
            <div className="recipe-cook-exit-warning">
              <span className="recipe-cook-exit-warning-icon"><RecipeUiIcon name="warning" /></span>
              <div>
                <strong>正在计时</strong>
                <span>返回做菜页面后，可从当前进度继续计时。</span>
              </div>
            </div>
            <div className="recipe-cook-exit-timers" aria-label="正在运行的计时器">
              {runningTimers.map((timer) => {
                const displaySeconds = timer.mode === 'countdown'
                  ? Math.max((timer.durationSeconds ?? 0) - timer.seconds, 0)
                  : timer.seconds;
                return (
                  <div key={timer.id} className="recipe-cook-exit-timer">
                    <span><RecipeUiIcon name="clock" /></span>
                    <div>
                      <strong>{timer.name}</strong>
                      <small>{timer.mode === 'countdown' ? '剩余时间' : '已用时间'}</small>
                    </div>
                    <b>{formatCookTimer(displaySeconds)}</b>
                  </div>
                );
              })}
            </div>
            <div className="workspace-overlay-actions">
              <ActionButton tone="secondary" type="button" onClick={() => setPendingExitTarget(null)}>
                继续烹饪
              </ActionButton>
              <ActionButton
                tone="primary"
                type="button"
                onClick={() => {
                  const target = pendingExitTarget;
                  setPendingExitTarget(null);
                  exitCookMode(target);
                }}
              >
                暂停并退出
              </ActionButton>
            </div>
          </WorkspaceModal>
        </div>
      )}

      {deletingTimerId && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setDeletingTimerId(null)} />
          <WorkspaceModal
            title="确认删除正在运行的计时器？"
            description="该计时器正在运行中，删除后将无法恢复计时进度。"
            eyebrow="删除确认"
            onClose={() => setDeletingTimerId(null)}
            className="recipe-cook-timer-delete-modal"
          >
            <div className="workspace-overlay-actions">
              <ActionButton tone="secondary" type="button" onClick={() => setDeletingTimerId(null)}>
                继续计时
              </ActionButton>
              <ActionButton
                tone="primary"
                className="danger"
                type="button"
                onClick={() => {
                  const target = timers.find((t) => t.id === deletingTimerId);
                  if (target) deleteTimer(target.id);
                  setDeletingTimerId(null);
                }}
              >
                确认删除
              </ActionButton>
            </div>
          </WorkspaceModal>
        </div>
      )}
    </main>
  );
}

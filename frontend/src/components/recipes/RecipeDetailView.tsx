import { ActionButton, Badge, WorkspaceSubpageShell } from '../ui-kit';
import { formatDate, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { RecipeCover, RecipeUiIcon } from './RecipeWorkspaceCards';
import { SHOW_RECIPE_PLAN_MANAGEMENT } from './RecipeWorkspaceOptions';
import { getRecipeStepSummary, getRecipeStepTitle, resolveIngredientImageUrl } from './RecipeWorkspaceModel';
import { DIFFICULTY_LABELS, type RecipeCardViewModel } from './workspaceModel';

type RecipeDetailViewProps = {
  selectedCard: RecipeCardViewModel;
  selectedReadyCount: number;
  selectedIngredientCount: number;
  selectedShortageCount: number;
  isSelectedFavorite: boolean;
  selectedRecentCookLog: RecipeCardViewModel['recipe']['cook_logs'][number] | null;
  selectedRecipePlanItems: Array<{ id: string }>;
  isUpdatingFavorite?: boolean;
  isCreatingShopping?: boolean;
  isDeletingRecipe?: boolean;
  onBack: () => void;
  onCook: (card: RecipeCardViewModel) => void;
  onPlan: (card: RecipeCardViewModel) => void;
  onShopping: (card: RecipeCardViewModel) => void;
  onToggleFavorite: (card: RecipeCardViewModel) => Promise<void> | void;
  onEdit: (card: RecipeCardViewModel) => void;
  onDelete: () => Promise<void> | void;
};

export function RecipeDetailView({
  selectedCard,
  selectedReadyCount,
  selectedIngredientCount,
  selectedShortageCount,
  isSelectedFavorite,
  selectedRecentCookLog,
  selectedRecipePlanItems,
  isUpdatingFavorite,
  isCreatingShopping,
  isDeletingRecipe,
  onBack,
  onCook,
  onPlan,
  onShopping,
  onToggleFavorite,
  onEdit,
  onDelete,
}: RecipeDetailViewProps) {
  return (
        <WorkspaceSubpageShell className="recipe-detail-subpage">
          <div className="recipe-detail-topbar">
            <button className="workspace-back-link recipe-detail-back-link" type="button" onClick={() => onBack()}>
              <RecipeUiIcon name="chevronLeft" />
              返回菜谱
            </button>
            <Badge className={`recipe-availability-badge tone-${selectedCard.availability}`}>
              {selectedCard.availabilityLabel}
            </Badge>
          </div>

          <section className="recipe-detail-hero-panel">
            <div className="recipe-detail-title-block">
              <p className="eyebrow">菜谱资料</p>
              <h2>{selectedCard.recipe.title}</h2>
              <p className="recipe-detail-meta-line">
                {selectedCard.recipe.prep_minutes} 分钟 · {selectedCard.recipe.servings} 人份 · {selectedCard.availabilityLabel}
              </p>
            </div>

            <div className="recipe-detail-hero-grid">
              <RecipeCover card={selectedCard} className="recipe-detail-cover" />
              <div className="recipe-detail-hero-copy">
                <p>{selectedCard.recipe.tips || '这份菜谱还没有补充烹饪提示，可以在编辑里记录口味、火候和替换建议。'}</p>
                <div className="recipe-detail-metric-row">
                  <span>
                    <RecipeUiIcon name="clock" />
                    <strong>{selectedCard.recipe.prep_minutes}</strong>
                    分钟
                  </span>
                  <span>
                    <RecipeUiIcon name="users" />
                    <strong>{selectedCard.recipe.servings}</strong>
                    人份
                  </span>
                  <span>
                    <RecipeUiIcon name="signal" />
                    <strong>{DIFFICULTY_LABELS[selectedCard.recipe.difficulty]}</strong>
                    难度
                  </span>
                  <span>
                    <RecipeUiIcon name="reset" />
                    <strong>{selectedCard.mealUsageCount}</strong>
                    次复做
                  </span>
                </div>
                <div className="recipe-detail-actions">
                  <ActionButton tone="primary" type="button" onClick={() => onCook(selectedCard)}>
                    <RecipeUiIcon name="play" />
                    开始做
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => onPlan(selectedCard)}>
                    <RecipeUiIcon name="calendar" />
                    加入计划
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => onShopping(selectedCard)} disabled={isCreatingShopping}>
                    <RecipeUiIcon name="basket" />
                    加入采购
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => void onToggleFavorite(selectedCard)} disabled={isUpdatingFavorite}>
                    <RecipeUiIcon name="star" />
                    {isSelectedFavorite ? '已收藏' : '收藏'}
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => onEdit(selectedCard)}>
                    <RecipeUiIcon name="edit" />
                    编辑
                  </ActionButton>
                </div>
              </div>
            </div>
          </section>

          <div className="recipe-detail-content-grid">
            <main className="recipe-detail-main-column">
              <section className="recipe-detail-section recipe-detail-ingredients-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="basket" /></span>
                  <div>
                    <h3>用料与库存</h3>
                    <p>根据当前库存判断，缺 {selectedShortageCount} 项</p>
                  </div>
                </div>
                {selectedCard.ingredientAvailability.length > 0 ? (
                  <div className="recipe-detail-ingredient-table">
                    <div className="recipe-detail-ingredient-head">
                      <span>食材与处理</span>
                      <span>需要量</span>
                      <span>备注</span>
                      <span>库存状态</span>
                    </div>
                    {selectedCard.ingredientAvailability.map((item) => (
                      <article key={item.item.id} className="recipe-detail-ingredient-row">
                        <div className="recipe-detail-ingredient-name">
                          <img src={resolveIngredientImageUrl(item.ingredient, item.item.ingredient_name)} alt={item.item.ingredient_name} />
                          <strong>{item.item.ingredient_name}</strong>
                        </div>
                        <span>{item.item.quantity}{item.item.unit}</span>
                        <span>{item.item.note || '搭配主食'}</span>
                        <Badge className={item.ready ? 'recipe-stock-badge ready' : 'recipe-stock-badge missing'}>
                          {item.ready ? '已备齐' : `缺 ${item.missingQuantity}${item.unit}`}
                        </Badge>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">还没有录入用料。</p>
                )}
              </section>

              <section className="recipe-detail-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="clipboard" /></span>
                  <div>
                    <h3>做法步骤</h3>
                    <p>按顺序完成关键步骤</p>
                  </div>
                </div>
                <ol className="recipe-detail-step-timeline">
                  {selectedCard.recipe.steps.length > 0 ? selectedCard.recipe.steps.map((step, index) => (
                    <li key={step.id}>
                      <span className="recipe-detail-step-index">{index + 1}</span>
                      <div>
                        <strong>{getRecipeStepTitle(step, index)}</strong>
                        <p>{getRecipeStepSummary(step)}</p>
                        {step.tip ? <small>{step.tip}</small> : null}
                      </div>
                      {step.estimated_minutes ? <Badge>约 {step.estimated_minutes} 分钟</Badge> : null}
                    </li>
                  )) : (
                    <li>
                      <span className="recipe-detail-step-index">1</span>
                      <div>
                        <strong>还没有步骤</strong>
                        <p>可以在编辑里补充烹饪流程。</p>
                      </div>
                    </li>
                  )}
                </ol>
              </section>

              <section className="recipe-detail-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="sparkle" /></span>
                  <div>
                    <h3>烹饪提示与复做记录</h3>
                    <p>把口味调整和家人反馈留在这里</p>
                  </div>
                </div>
                <div className="recipe-detail-note-grid">
                  <article>
                    <h4>烹饪提示</h4>
                    <p>{selectedCard.recipe.tips || '暂无额外提示。'}</p>
                  </article>
                  <article>
                    <h4>最近复做反馈</h4>
                    {selectedRecentCookLog ? (
                      <>
                        <p>
                          {formatDate(selectedRecentCookLog.cook_date)} · {selectedRecentCookLog.adjustments || selectedRecentCookLog.result_note || '这次没有额外记录。'}
                        </p>
                        <div className="recipe-detail-note-footer">
                          <span>{MEAL_TYPE_LABELS[selectedRecentCookLog.meal_type]}</span>
                          <Badge>{selectedRecentCookLog.rating ? `${selectedRecentCookLog.rating}/5` : `${selectedRecentCookLog.servings} 人份`}</Badge>
                        </div>
                      </>
                    ) : (
                      <p>做完一次后，这里会留下本次调整和满意度。</p>
                    )}
                  </article>
                </div>
              </section>
            </main>

            <aside className="recipe-detail-side-column">
              <section className="recipe-detail-side-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="basket" /></span>
                  <div>
                    <h3>库存判断</h3>
                    <p>当前库存覆盖 {selectedReadyCount} / {selectedIngredientCount} 项</p>
                  </div>
                </div>
                <div className={`recipe-detail-stock-summary tone-${selectedCard.availability}`}>
                  <span><RecipeUiIcon name={selectedShortageCount > 0 ? 'warning' : 'check'} /></span>
                  <strong>{selectedShortageCount > 0 ? '需要先补齐食材' : '可以立即开始'}</strong>
                  <small>共需 {selectedIngredientCount} 项食材，缺 {selectedShortageCount} 项</small>
                </div>
                {selectedCard.shortages.length > 0 ? (
                  <div className="recipe-detail-shortage-list">
                    <strong>缺少食材</strong>
                    {selectedCard.shortages.slice(0, 3).map((item) => (
                      <span key={`${item.ingredientName}-${item.unit}`}>· {item.ingredientName} {item.missingQuantity}{item.unit}</span>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">主要用料已经备齐。</p>
                )}
                <button className="recipe-detail-link-button" type="button" onClick={() => onShopping(selectedCard)}>
                  查看采购清单 <RecipeUiIcon name="chevronRight" />
                </button>
              </section>

              {SHOW_RECIPE_PLAN_MANAGEMENT && (
              <section className="recipe-detail-side-card recipe-detail-plan-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="calendar" /></span>
                  <div>
                    <h3>菜谱计划</h3>
                    <p>{selectedRecipePlanItems.length > 0 ? `已加入 ${selectedRecipePlanItems.length} 个计划` : '将此菜谱加入本周计划'}</p>
                  </div>
                </div>
                <ActionButton tone="secondary" size="compact" type="button" onClick={() => onPlan(selectedCard)}>
                  加入计划
                </ActionButton>
              </section>
              )}

              <section className="recipe-detail-side-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="info" /></span>
                  <div>
                    <h3>菜谱信息</h3>
                  </div>
                </div>
                <dl className="recipe-detail-info-list">
                  <div><dt>最近更新</dt><dd>{formatDateTime(selectedCard.recipe.updated_at)}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatDateTime(selectedCard.recipe.created_at)}</dd></div>
                  <div><dt>创建者</dt><dd>{selectedCard.recipe.created_by || '家庭成员'}</dd></div>
                  <div><dt>来源/备注</dt><dd>{selectedCard.linkedFood ? selectedCard.linkedFood.name : '家庭自制菜谱'}</dd></div>
                </dl>
                <ActionButton tone="tertiary" size="compact" type="button" onClick={() => void onDelete()} disabled={isDeletingRecipe}>
                  删除菜谱
                </ActionButton>
              </section>

            </aside>
          </div>
        </WorkspaceSubpageShell>

  );
}

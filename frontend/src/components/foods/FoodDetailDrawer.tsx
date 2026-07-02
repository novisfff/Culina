import type { Food, MealLog, MealType, Recipe, MediaAsset } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDate } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import type { RecipeCardViewModel } from '../recipes/workspaceModel';
import { ActionButton, Badge, WorkspaceDrawer } from '../ui-kit';
import { FoodIconName, FoodUiIcon } from './FoodWorkspacePrimitives';

type FoodFactRow = {
  label: string;
  value: string;
};

type FoodStatusView = {
  label: string;
  detail: string;
  tone: string;
};

type FoodRelationView = {
  linkedRecipeCard: RecipeCardViewModel | null;
  lastMealLog: MealLog | null;
  relationFacts: FoodFactRow[];
  shortagePreview: string[];
  summary: string;
  detail: string;
};

type FoodMealHistoryItem = {
  log: MealLog;
  entry: MealLog['food_entries'][number] | undefined;
};

type MealOption = {
  value: MealType;
  label: string;
};

type Props = {
  food: Food;
  audienceText: string;
  cover?: string | null;
  coverAsset?: MediaAsset | null;
  detailMealOptions: MealOption[];
  expiry: string | null;
  factRows: FoodFactRow[];
  history: FoodMealHistoryItem[];
  isOutsideFood: boolean;
  isQuickAdding?: boolean;
  isReadyLikeFood: boolean;
  normalizedType: Exclude<Food['type'], 'packaged'>;
  recipe: Recipe | null;
  relation: FoodRelationView;
  status: FoodStatusView;
  usage: { count: number; last: string | null };
  getDefaultMealType: (food: Food) => MealType;
  getPrimaryFoodActionLabel: (food: Food) => string;
  getRepurchaseLabel: (food: Food) => string;
  getSecondaryFoodActionLabel: (food: Food) => string;
  getSceneTags: (food: Food) => string[];
  onClose: () => void;
  onOpenLogs: () => void;
  onOpenPlanDialog: (food: Food) => void;
  onStartCook: (recipeId: string) => void;
  onEditRecipe: (food: Food) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
  onEdit: (food: Food) => void;
  resolveAssetUrl: (url: string) => string;
  overlayRootClassName?: string;
};


function getFactIcon(label: string): FoodIconName {
  if (label.includes('菜谱')) return 'bookOpen';
  if (label.includes('复吃') || label.includes('复购') || label.includes('吃过')) return 'refresh';
  if (label.includes('餐别')) return 'bowl';
  if (label.includes('价格') || label.includes('人均')) return 'receipt';
  if (label.includes('库存')) return 'clipboard';
  if (label.includes('到期')) return 'calendar';
  if (label.includes('渠道') || label.includes('店铺') || label.includes('餐厅') || label.includes('来源')) return 'home';
  if (label.includes('场景')) return 'tag';
  return 'star';
}

function getFactTone(label: string, value: string): 'warning' | 'success' | 'danger' | 'neutral' {
  if (value === '待完善' || value === '未设置' || value === '未记录' || value === '待补充' || value === '未评分') return 'warning';
  if (value === '已完善' || value === '库存充足' || value === '已有' || value === '正常') return 'success';
  if (label.includes('到期') && (value.includes('天') || value.includes('已过期') || value.includes('过期'))) return 'danger';
  return 'neutral';
}

export function FoodDetailDrawer(props: Props) {
  const linkedRecipeCard = props.relation.linkedRecipeCard;
  const coverUrl = resolveMediaUrl(props.coverAsset, 'large') ?? (props.cover ? props.resolveAssetUrl(props.cover) : undefined);
  const showRelationPanel = !props.isOutsideFood && !props.isReadyLikeFood && !props.recipe;
  const canStartCook = props.normalizedType === 'selfMade' && Boolean(props.food.recipe_id);
  const detailActions = (
    <div className="workspace-overlay-actions food-detail-actions">
      <ActionButton
        tone="primary"
        type="button"
        onClick={() => {
          if (canStartCook && props.food.recipe_id) {
            props.onStartCook(props.food.recipe_id);
            return;
          }
          props.onQuickAdd(props.food, props.getDefaultMealType(props.food));
        }}
      >
        {canStartCook ? '开始做' : props.getPrimaryFoodActionLabel(props.food)}
      </ActionButton>
      <ActionButton tone="secondary" type="button" onClick={() => props.onEdit(props.food)}>
        {props.getSecondaryFoodActionLabel(props.food)}
      </ActionButton>
      <ActionButton tone="secondary" type="button" onClick={() => props.onOpenPlanDialog(props.food)}>
        加入菜单
      </ActionButton>
      <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
        完整记一餐
      </ActionButton>
    </div>
  );

  return (
    <div className={props.overlayRootClassName ? `workspace-overlay-root ${props.overlayRootClassName}` : 'workspace-overlay-root'}>
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceDrawer
        eyebrow={FOOD_TYPE_LABELS[props.normalizedType]}
        title={props.food.name}
        description={props.food.routine_note || props.food.notes || props.getSceneTags(props.food).join('、') || props.food.scene || '这份食物还没有补充决策备注。'}
        className="food-detail-drawer"
        onClose={props.onClose}
      >
        <div className="food-detail-hero">
          <div className="food-detail-cover">
            <MediaWithPlaceholder
              src={coverUrl}
              srcSet={buildMediaSrcSet(props.coverAsset)}
              sizes={buildMediaSizes('hero')}
              alt={props.food.name}
            />
          </div>
          <div className="food-detail-status-row">
            <span className={`food-card-status tone-${props.status.tone}`}>
              <strong>{props.status.label}</strong>
              <small>{props.status.detail}</small>
            </span>
            <Badge>{props.food.favorite ? '已收藏' : props.getRepurchaseLabel(props.food)}</Badge>
          </div>
        </div>

        {detailActions}

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>决策信息</h4>
            <span>{props.audienceText}</span>
          </div>
          <div className="food-fact-grid">
            {props.factRows.map((row) => (
              <div key={row.label} className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone(row.label, row.value)}`}>
                  <FoodUiIcon name={getFactIcon(row.label)} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">{row.label}</span>
                  <strong className="fact-value">{row.value}</strong>
                </div>
              </div>
            ))}
            {!props.factRows.some(row => row.label === '餐别' || row.label === '适合餐别') && (
              <div className="food-fact-item">
                <div className="fact-icon-wrapper tone-neutral">
                  <FoodUiIcon name="bowl" className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">适合餐别</span>
                  <strong className="fact-value">
                    {props.food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置'}
                  </strong>
                </div>
              </div>
            )}
            <div className="food-fact-item">
              <div className="fact-icon-wrapper tone-neutral">
                <FoodUiIcon name="tag" className="fact-icon" />
              </div>
              <div className="fact-info">
                <span className="fact-label">适合场景</span>
                <strong className="fact-value">
                  {props.getSceneTags(props.food).join('、') || props.food.scene || props.food.category || '未设置'}
                </strong>
              </div>
            </div>
          </div>
        </section>

        {showRelationPanel && (
          <section className="food-detail-section">
            <div className="food-detail-section-head">
              <h4>关系面板</h4>
              <span>{props.relation.summary}</span>
            </div>
            <div className="food-fact-grid">
              {props.relation.relationFacts.map((row) => (
                <div key={row.label} className="food-fact-item">
                  <div className={`fact-icon-wrapper tone-${getFactTone(row.label, row.value)}`}>
                    <FoodUiIcon name={getFactIcon(row.label)} className="fact-icon" />
                  </div>
                  <div className="fact-info">
                    <span className="fact-label">{row.label}</span>
                    <strong className="fact-value">{row.value}</strong>
                  </div>
                </div>
              ))}
            </div>
            <p className={`food-detail-empty ${props.relation.shortagePreview.length > 0 ? 'has-shortage' : ''}`}>
              {props.relation.shortagePreview.length > 0 && <span className="shortage-warning-icon">⚠</span>}
              {props.relation.detail}
            </p>
          </section>
        )}

        {props.recipe && (
          <section className="food-detail-section food-detail-recipe-card">
            <div className="food-detail-recipe-header">
              <span className="recipe-badge">
                <FoodUiIcon name="bowl" className="recipe-badge-icon" /> 家常菜谱
              </span>
              <h4 className="recipe-title">{props.recipe.title}</h4>
            </div>

            <div className="food-detail-recipe-metrics">
              <div className="metric-box">
                <strong className="metric-value">{props.usage.count > 0 ? `${props.usage.count}次` : '还未记录'}</strong>
                <span className="metric-label">餐食记录</span>
              </div>
              <div className="metric-divider" />
              <div className="metric-box">
                <strong className="metric-value">{props.relation.lastMealLog ? formatDate(props.relation.lastMealLog.date) : '还没有'}</strong>
                <span className="metric-label">最近一次</span>
              </div>
              <div className="metric-divider" />
              <div className="metric-box">
                <strong className="metric-value">{props.recipe.ingredient_items.length}个</strong>
                <span className="metric-label">所需原料</span>
              </div>
            </div>

            {props.relation.shortagePreview.length > 0 ? (
              <div className="recipe-status-alert missing">
                <span className="alert-badge">需要补齐</span>
                <p className="alert-text">
                  缺少 <strong>{props.relation.shortagePreview.length}</strong> 种食材：{props.relation.shortagePreview.join('、')}
                </p>
              </div>
            ) : (
              <div className="recipe-status-alert ready">
                <span className="alert-badge">食材齐全</span>
                <p className="alert-text">
                  全部原料均有库存，可以直接开始烹饪。
                </p>
              </div>
            )}

            {linkedRecipeCard && (
              <div className="recipe-ingredients-pills">
                {linkedRecipeCard.ingredientAvailability.map((item) => (
                  <div key={item.item.id} className={`ingredient-pill ${item.ready ? 'ready' : 'missing'}`}>
                    <span className="pill-dot" />
                    <span className="pill-name">{item.item.ingredient_name}</span>
                    <span className="pill-status">{item.ready ? '已有' : `缺 ${item.missingQuantity}${item.unit}`}</span>
                  </div>
                ))}
              </div>
            )}

            {props.recipe.steps.length > 0 && (
              <div className="recipe-steps-timeline">
                {props.recipe.steps.map((step, index) => (
                  <div key={step.id || `${props.recipe?.id}-step-${index}`} className="timeline-item">
                    <div className="timeline-badge">{index + 1}</div>
                    <div className="timeline-content">
                      <p className="timeline-text">{step.summary || step.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="food-detail-recipe-actions">
              <ActionButton tone="secondary" size="compact" type="button" onClick={() => props.onEditRecipe(props.food)}>
                编辑菜谱
              </ActionButton>
            </div>
          </section>
        )}

        {props.isOutsideFood && (
          <section className="food-detail-section">
            <div className="food-detail-section-head">
              <h4>复吃判断</h4>
              <span>{props.getRepurchaseLabel(props.food)}</span>
            </div>
            <div className="food-fact-grid">
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone(props.normalizedType === 'takeout' ? '店铺' : '餐厅', props.food.source_name || '')}`}>
                  <FoodUiIcon name={getFactIcon(props.normalizedType === 'takeout' ? '店铺' : '餐厅')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">{props.normalizedType === 'takeout' ? '店铺' : '餐厅'}</span>
                  <strong className="fact-value">{props.food.source_name || '未记录'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('历史记录', props.usage.count > 0 ? `${props.usage.count} 次` : '还未记录')}`}>
                  <FoodUiIcon name={getFactIcon('历史记录')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">历史记录</span>
                  <strong className="fact-value">{props.usage.count > 0 ? `${props.usage.count} 次` : '还未记录'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('最近一次', props.relation.lastMealLog ? '正常' : '还没有')}`}>
                  <FoodUiIcon name={getFactIcon('最近一次')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">最近一次</span>
                  <strong className="fact-value">{props.relation.lastMealLog ? formatDate(props.relation.lastMealLog.date) : '还没有'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('价格', props.food.price == null ? '未记录' : `¥${props.food.price}`)}`}>
                  <FoodUiIcon name={getFactIcon('价格')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">价格 / 人均</span>
                  <strong className="fact-value">{props.food.price == null ? '未记录' : `¥${props.food.price}`}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('评分', props.food.rating == null ? '未评分' : `${props.food.rating} 分`)}`}>
                  <FoodUiIcon name={getFactIcon('评分')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">评分</span>
                  <strong className="fact-value">{props.food.rating == null ? '未评分' : `${props.food.rating} 分`}</strong>
                </div>
              </div>
            </div>
          </section>
        )}

        {props.isReadyLikeFood && (
          <section className="food-detail-section">
            <div className="food-detail-section-head">
              <h4>库存与到期</h4>
              <span>{props.expiry ?? '未记录到期'}</span>
            </div>
            <div className="food-fact-grid">
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('剩余库存', props.food.stock_quantity == null ? '未记录' : `${props.food.stock_quantity}${props.food.stock_unit}`)}`}>
                  <FoodUiIcon name={getFactIcon('剩余库存')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">剩余库存</span>
                  <strong className="fact-value">{props.food.stock_quantity == null ? '未记录' : `${props.food.stock_quantity}${props.food.stock_unit}`}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('购买渠道', props.food.purchase_source || props.food.source_name || '')}`}>
                  <FoodUiIcon name={getFactIcon('购买渠道')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">购买渠道</span>
                  <strong className="fact-value">{props.food.purchase_source || props.food.source_name || '未记录'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('到期日期', props.food.expiry_date ? '正常' : '未记录')}`}>
                  <FoodUiIcon name={getFactIcon('到期日期')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">到期日期</span>
                  <strong className="fact-value">{props.food.expiry_date ? formatDate(props.food.expiry_date) : '未记录'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('餐食记录', props.usage.count > 0 ? `${props.usage.count} 次` : '还未记录')}`}>
                  <FoodUiIcon name={getFactIcon('餐食记录')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">餐食记录</span>
                  <strong className="fact-value">{props.usage.count > 0 ? `${props.usage.count} 次` : '还未记录'}</strong>
                </div>
              </div>
              <div className="food-fact-item">
                <div className={`fact-icon-wrapper tone-${getFactTone('最近一次', props.relation.lastMealLog ? '正常' : '还没有')}`}>
                  <FoodUiIcon name={getFactIcon('最近一次')} className="fact-icon" />
                </div>
                <div className="fact-info">
                  <span className="fact-label">最近一次</span>
                  <strong className="fact-value">{props.relation.lastMealLog ? formatDate(props.relation.lastMealLog.date) : '还没有'}</strong>
                </div>
              </div>
            </div>
            {props.food.stock_quantity == null && <p className="food-detail-empty">这份成品速食还没有库存数量，补齐后会更容易判断是否适合作为今天的备用餐。</p>}
          </section>
        )}

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>快速记录</h4>
            <span>选择日期和餐次</span>
          </div>
          <div className="food-detail-meal-actions">
            {props.detailMealOptions.map((item) => (
              <button key={item.value} type="button" disabled={props.isQuickAdding} onClick={() => props.onQuickAdd(props.food, item.value)}>
                + {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>最近吃过</h4>
            <span>{props.usage.count > 0 ? `共 ${props.usage.count} 次 · 最近 ${props.relation.lastMealLog ? formatDate(props.relation.lastMealLog.date) : '未知'}` : '还没有记录'}</span>
          </div>
          {props.history.length > 0 ? (
            <div className="food-detail-history">
              {props.history.map(({ log, entry }) => (
                <article key={log.id}>
                  <div>
                    <strong>{formatDate(log.date)} · {MEAL_TYPE_LABELS[log.meal_type]}</strong>
                    <span>{entry?.servings ?? 1} 份{entry?.note ? ` · ${entry.note}` : ''}</span>
                  </div>
                  <small className={!(log.mood || log.notes) ? 'history-badge-recorded' : 'history-badge-review'}>
                    {log.mood || log.notes || '已记录'}
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="food-detail-empty">还没有吃过记录。加入今天后，这里会开始沉淀复吃历史。</p>
          )}
        </section>

      </WorkspaceDrawer>
    </div>
  );
}

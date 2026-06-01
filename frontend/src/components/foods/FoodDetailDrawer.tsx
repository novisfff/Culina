import type { Food, MealLog, MealType, Recipe } from '../../api/types';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDate } from '../../lib/ui';
import type { RecipeCardViewModel } from '../recipes/workspaceModel';
import { ActionButton, Badge, WorkspaceDrawer } from '../ui-kit';

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
  onOpenRecipes: () => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
  onEdit: (food: Food) => void;
  resolveAssetUrl: (url: string) => string;
};

export function FoodDetailDrawer(props: Props) {
  const linkedRecipeCard = props.relation.linkedRecipeCard;

  return (
    <div className="workspace-overlay-root">
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
            {props.cover ? <img src={props.resolveAssetUrl(props.cover)} alt={props.food.name} /> : <span>{props.food.name.slice(0, 4)}</span>}
          </div>
          <div className="food-detail-status-row">
            <span className={`food-card-status tone-${props.status.tone}`}>
              <strong>{props.status.label}</strong>
              <small>{props.status.detail}</small>
            </span>
            <Badge>{props.food.favorite ? '已收藏' : props.getRepurchaseLabel(props.food)}</Badge>
          </div>
        </div>

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>决策信息</h4>
            <span>{props.audienceText}</span>
          </div>
          <div className="food-detail-facts">
            {props.factRows.map((row) => (
              <div key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
          <div className="food-detail-context">
            <div>
              <span>适合餐别</span>
              <strong>{props.food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置'}</strong>
            </div>
            <div>
              <span>适合场景</span>
              <strong>{props.getSceneTags(props.food).join('、') || props.food.scene || props.food.category || '未设置'}</strong>
            </div>
          </div>
        </section>

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>关系面板</h4>
            <span>{props.relation.summary}</span>
          </div>
          <div className="food-detail-facts">
            {props.relation.relationFacts.map((row) => (
              <div key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
          <p className="food-detail-empty">{props.relation.detail}</p>
        </section>

        {props.recipe && (
          <section className="food-detail-section food-detail-recipe">
            <div className="food-detail-section-head">
              <h4>关联菜谱</h4>
              <span>{linkedRecipeCard ? linkedRecipeCard.availabilityLabel : `${props.recipe.ingredient_items.length} 个原料 · ${props.recipe.steps.length} 个步骤`}</span>
            </div>
            <strong>{props.recipe.title}</strong>
            <p>{linkedRecipeCard?.availabilityDetail || props.recipe.tips || '这份家常菜已经和菜谱关联，可以去菜谱页查看做法和复做记录。'}</p>
            {linkedRecipeCard && (
              <div className="food-detail-ingredient-grid">
                {linkedRecipeCard.ingredientAvailability.slice(0, 6).map((item) => (
                  <div key={item.item.id} className={item.ready ? 'ready' : 'missing'}>
                    <span>{item.item.ingredient_name}</span>
                    <strong>{item.ready ? '已有' : `缺 ${item.missingQuantity}${item.unit}`}</strong>
                  </div>
                ))}
              </div>
            )}
            {props.relation.shortagePreview.length > 0 && (
              <div className="food-detail-shortages">
                <span>缺料</span>
                {props.relation.shortagePreview.map((item) => <Badge key={item}>{item}</Badge>)}
              </div>
            )}
            <ActionButton tone="secondary" size="compact" type="button" onClick={props.onOpenRecipes}>
              看菜谱
            </ActionButton>
          </section>
        )}

        {props.isOutsideFood && (
          <section className="food-detail-section">
            <div className="food-detail-section-head">
              <h4>复吃判断</h4>
              <span>{props.getRepurchaseLabel(props.food)}</span>
            </div>
            <div className="food-detail-context">
              <div><span>{props.normalizedType === 'takeout' ? '店铺' : '餐厅'}</span><strong>{props.food.source_name || '未记录'}</strong></div>
              <div><span>历史记录</span><strong>{props.usage.count > 0 ? `${props.usage.count} 次` : '还未记录'}</strong></div>
              <div><span>最近一次</span><strong>{props.relation.lastMealLog ? formatDate(props.relation.lastMealLog.date) : '还没有'}</strong></div>
              <div><span>价格 / 人均</span><strong>{props.food.price == null ? '未记录' : `¥${props.food.price}`}</strong></div>
              <div><span>评分</span><strong>{props.food.rating == null ? '未评分' : `${props.food.rating} 分`}</strong></div>
            </div>
          </section>
        )}

        {props.isReadyLikeFood && (
          <section className="food-detail-section">
            <div className="food-detail-section-head">
              <h4>库存与到期</h4>
              <span>{props.expiry ?? '未记录到期'}</span>
            </div>
            <div className="food-detail-context">
              <div><span>剩余库存</span><strong>{props.food.stock_quantity == null ? '未记录' : `${props.food.stock_quantity}${props.food.stock_unit}`}</strong></div>
              <div><span>购买渠道</span><strong>{props.food.purchase_source || props.food.source_name || '未记录'}</strong></div>
              <div><span>到期日期</span><strong>{props.food.expiry_date ? formatDate(props.food.expiry_date) : '未记录'}</strong></div>
            </div>
            {props.food.stock_quantity == null && <p className="food-detail-empty">这份成品速食还没有库存数量，补齐后会更容易判断是否适合作为今天的备用餐。</p>}
          </section>
        )}

        <section className="food-detail-section">
          <div className="food-detail-section-head">
            <h4>加入今天</h4>
            <span>快速记录一餐</span>
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
                  <small>{log.mood || log.notes || '已记录'}</small>
                </article>
              ))}
            </div>
          ) : (
            <p className="food-detail-empty">还没有吃过记录。加入今天后，这里会开始沉淀复吃历史。</p>
          )}
        </section>

        <div className="workspace-overlay-actions food-detail-actions">
          <ActionButton tone="primary" type="button" onClick={() => props.onQuickAdd(props.food, props.getDefaultMealType(props.food))}>
            {props.getPrimaryFoodActionLabel(props.food)}
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
      </WorkspaceDrawer>
    </div>
  );
}

import { useEffect, useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryStatus,
  MealLog,
  Member,
  Recipe,
  ShoppingListItem,
  UpdateMealLogPayload,
} from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import type {
  DisposableExpiredInventoryItemViewModel,
  IngredientSummaryViewModel,
} from '../../components/ingredients/workspaceModel';
import { Avatar, Badge, DropdownSelect, EmptyState, FormActions, OptionChipGroup, SearchableResourceSelect, WorkspaceModal } from '../../components/ui-kit';
import { resolveMediaUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { useFoodResourceSearch } from '../../hooks/useFoodResourceSearch';
import { useIngredientResourceSearch } from '../../hooks/useIngredientResourceSearch';
import {
  FOOD_TYPE_LABELS,
  formatDate,
  formatDateTime,
  formatRelativeDays,
  getFoodCover,
  INVENTORY_STATUS_LABELS,
  MEAL_TYPE_LABELS,
  todayKey,
} from '../../lib/ui';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  getExpiryDaysLeft,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
  type DashboardExpiryTodoInventoryItem,
  type DashboardPlanDay,
  type HomeRestockFormState,
} from './homeDashboardModel';
import type { HomePlanAddFormState } from './useHomeDashboardState';
import { MealEnrichmentForm, type MealSource } from '../meals/MealLogEnrichment';

type Props = {
  recipes: Recipe[];
  ingredients: Ingredient[];
  homePlanDetailItem: FoodPlanItem | null;
  homePlanDetailFood: Food | null;
  homePlanDetailForm: FoodPlanDetailFormState;
  isHomePlanDetailEditing: boolean;
  setHomePlanDetailForm: (form: FoodPlanDetailFormState) => void;
  setIsHomePlanDetailEditing: (value: boolean) => void;
  resetHomePlanDetailForm: (item?: FoodPlanItem | null) => void;
  submitHomePlanDetail: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  startHomePlanDetailCook: (item: FoodPlanItem) => Promise<void>;
  supplementHomePlanDetailRecord: (item: FoodPlanItem) => Promise<void>;
  deleteHomePlanDetail: (item: FoodPlanItem) => Promise<void>;
  closeHomePlanDetail: () => void;
  isUpdatingHomePlanDetail: boolean;
  isCompletingHomePlanDetail: boolean;
  isSupplementingHomePlanDetail: boolean;
  homeMealEnrichmentMeal: MealLog | null;
  homeMealEnrichmentSource: MealSource | null;
  homeMealEnrichmentMembers: Member[];
  closeHomeMealEnrichment: () => void;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onInvalidMealEnrichmentSave: () => void;
  isUpdatingMeal: boolean;
  isHomePlanAddDialogOpen: boolean;
  homePlanAddFood: Food | null;
  homePlanAddFoodSearch: string;
  setHomePlanAddFoodSearch: (value: string) => void;
  homePlanAddFoodOptions: Food[];
  selectHomePlanAddFood: (food: Food) => void;
  setHomePlanAddFoodId: (value: string | null) => void;
  homePlanAddForm: HomePlanAddFormState;
  setHomePlanAddForm: Dispatch<SetStateAction<HomePlanAddFormState>>;
  dashboardPlanDays: DashboardPlanDay[];
  submitHomePlanAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  closeHomePlanAddDialog: () => void;
  isCreatingFoodPlanItem: boolean;
  homeExpiryReviewItem: DashboardExpiryTodoInventoryItem | null;
  homeExpiryReviewIngredient: Ingredient | null;
  closeHomeExpiryReview: () => void;
  openIngredientDetail: (ingredientId: string) => void;
  homeMealDetail: MealLog | null;
  homeMealDetailParticipants: Member[];
  closeHomeMealDetail: () => void;
  homeRestockShoppingItem: ShoppingListItem | null;
  homeRestockForm: HomeRestockFormState | null;
  homeRestockIngredient: Ingredient | null;
  homeRestockIngredientImageUrl?: string;
  updateHomeRestockForm: (next: HomeRestockFormState) => void;
  closeHomeRestock: () => void;
  submitHomeRestock: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingInventory: boolean;
  homeExpiredDisposalSummary: IngredientSummaryViewModel | null;
  homeExpiredDisposalItems: DisposableExpiredInventoryItemViewModel[];
  setHomeExpiredDisposalIngredientId: (value: string | null) => void;
  submitHomeExpiredDisposal: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isDisposingExpiredInventory: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
};

export function HomeDashboardDialogs(props: Props) {
  const today = todayKey();
  const homePlanDetailItem = props.homePlanDetailItem;
  const homeExpiryReviewItem = props.homeExpiryReviewItem;
  const homeRestockShoppingItem = props.homeRestockShoppingItem;
  const homeRestockForm = props.homeRestockForm;
  const homePlanAddFormId = 'home-plan-add-overlay-form';
  const homeRestockFormId = 'home-restock-overlay-form';
  const homeExpiredDisposalFormId = 'home-expired-disposal-overlay-form';
  const homeMealEnrichmentFormId = 'home-meal-enrichment-overlay-form';

  const statusOptions = useMemo(() => {
    return Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => ({
      value: key,
      label: label,
    }));
  }, []);

  const [showIngredientSelector, setShowIngredientSelector] = useState(false);
  const homeRestockIngredientSearch = useIngredientResourceSearch(homeRestockForm?.ingredientQuery ?? '', {
    enabled: Boolean(homeRestockShoppingItem && homeRestockForm && showIngredientSelector),
    fallbackIngredients: props.ingredients,
  });
  const homePlanFoodSearch = useFoodResourceSearch(props.homePlanAddFoodSearch, {
    enabled: props.isHomePlanAddDialogOpen && !props.homePlanAddFood,
    fallbackFoods: props.homePlanAddFoodOptions,
  });

  useEffect(() => {
    setShowIngredientSelector(false);
  }, [homeRestockShoppingItem?.id]);

  function updateHomeRestockIngredientQuery(query: string) {
    if (!homeRestockForm) return;
    const normalizedQuery = query.trim();
    const match = normalizedQuery
      ? homeRestockIngredientSearch.findIngredientByName(normalizedQuery)
        ?? props.ingredients.find((item) => item.name.includes(normalizedQuery) || normalizedQuery.includes(item.name))
        ?? null
      : null;
    props.updateHomeRestockForm({
      ...homeRestockForm,
      ingredientQuery: query,
      ingredientId: match?.id ?? '',
      unit: match?.default_unit || homeRestockForm.unit,
      storageLocation: match?.default_storage || homeRestockForm.storageLocation,
      expiryInputMode: match?.default_expiry_mode ?? homeRestockForm.expiryInputMode,
      expiryDays:
        match?.default_expiry_mode === 'days' && match.default_expiry_days
          ? String(match.default_expiry_days)
          : homeRestockForm.expiryDays,
      expiryDate:
        match?.default_expiry_mode === 'days' && match.default_expiry_days
          ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, String(match.default_expiry_days))
          : homeRestockForm.expiryDate,
      status: resolveInventoryStatusForStorage(match?.default_storage || homeRestockForm.storageLocation),
    });
  }

  function selectHomeRestockIngredient(ingredient: Ingredient) {
    if (!homeRestockForm) return;
    props.updateHomeRestockForm({
      ...homeRestockForm,
      ingredientId: ingredient.id,
      ingredientQuery: ingredient.name,
      unit: ingredient.default_unit || homeRestockForm.unit,
      storageLocation: ingredient.default_storage || homeRestockForm.storageLocation,
      expiryInputMode: ingredient.default_expiry_mode,
      expiryDays:
        ingredient.default_expiry_mode === 'days' && ingredient.default_expiry_days
          ? String(ingredient.default_expiry_days)
          : '',
      expiryDate:
        ingredient.default_expiry_mode === 'days' && ingredient.default_expiry_days
          ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, String(ingredient.default_expiry_days))
          : '',
      status: resolveInventoryStatusForStorage(ingredient.default_storage || homeRestockForm.storageLocation),
    });
    setShowIngredientSelector(false);
  }

  return (
    <>
      {homePlanDetailItem && (
        <FoodPlanDetailModal
          item={homePlanDetailItem}
          food={props.homePlanDetailFood}
          recipes={props.recipes}
          form={props.homePlanDetailForm}
          isEditing={props.isHomePlanDetailEditing}
          isUpdatingPlan={props.isUpdatingHomePlanDetail}
          isCompleting={props.isCompletingHomePlanDetail}
          isSupplementing={props.isSupplementingHomePlanDetail}
          onClose={props.closeHomePlanDetail}
          onChangeForm={props.setHomePlanDetailForm}
          onEditingChange={props.setIsHomePlanDetailEditing}
          onResetEdit={() => props.resetHomePlanDetailForm(homePlanDetailItem)}
          onSubmit={(event) => void props.submitHomePlanDetail(event)}
          onComplete={() => void props.startHomePlanDetailCook(homePlanDetailItem)}
          onSupplementRecord={() => void props.supplementHomePlanDetailRecord(homePlanDetailItem)}
          onDelete={() => void props.deleteHomePlanDetail(homePlanDetailItem)}
          resolveAssetUrl={(url) => props.resolveAssetUrl(url) ?? url}
          overlayRootClassName="home-dashboard-overlay-root"
        />
      )}

      {props.isHomePlanAddDialogOpen && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.closeHomePlanAddDialog} />
          <WorkspaceModal
            title="加食物到菜单"
            description="选择日期和餐次后加入当前周菜单。"
            eyebrow="菜单计划"
            onClose={props.closeHomePlanAddDialog}
            className="recipe-plan-modal food-plan-modal"
            footerActions={
              <FormActions
                className="recipe-plan-dialog-actions"
                primaryLabel="加入菜单"
                primaryType="submit"
                primaryForm={homePlanAddFormId}
                primaryDisabled={!props.homePlanAddFood}
                isSubmitting={props.isCreatingFoodPlanItem}
                secondaryLabel="取消"
                onSecondary={props.closeHomePlanAddDialog}
              />
            }
          >
            <form id={homePlanAddFormId} className="recipe-plan-dialog-form" onSubmit={(event) => void props.submitHomePlanAdd(event)}>
              {props.homePlanAddFood ? (
                <div className="recipe-plan-dialog-hero">
                  <div className="recipe-plan-selected-cover">
                    <MediaWithPlaceholder
                      src={props.resolveAssetUrl(getFoodCover(props.homePlanAddFood, props.recipes))}
                      alt={props.homePlanAddFood.name}
                    />
                  </div>
                  <div className="recipe-plan-selected-copy">
                    <span className="recipe-plan-dialog-kicker">即将加入</span>
                    <strong>{props.homePlanAddFood.name}</strong>
                    <div className="recipe-plan-selected-meta">
                      <span>
                        <DashboardIcon name="list" />
                        {FOOD_TYPE_LABELS[props.homePlanAddFood.type]}
                      </span>
                      <span>
                        <DashboardIcon name="calendar" />
                        {props.homePlanAddFood.source_name || props.homePlanAddFood.purchase_source || props.homePlanAddFood.category || '常吃食物'}
                      </span>
                      <span>
                        <DashboardIcon name={props.homePlanAddFood.recipe_id ? 'pot' : 'receipt'} />
                        {props.homePlanAddFood.recipe_id ? '有菜谱' : '可直接记录'}
                      </span>
                    </div>
                  </div>
                  <button className="recipe-plan-change-food" type="button" onClick={() => props.setHomePlanAddFoodId(null)}>
                    修改
                  </button>
                </div>
              ) : (
                <div className="recipe-plan-picker">
                  <label htmlFor="home-food-plan-search">选择食物</label>
                  <SearchableResourceSelect
                    searchInputId="home-food-plan-search"
                    ariaLabel="选择食物"
                    placeholder="搜索食物、来源、场景或备注"
                    value=""
                    query={props.homePlanAddFoodSearch}
                    presentation="popover"
                    loading={homePlanFoodSearch.isSearching}
                    loadingMore={homePlanFoodSearch.isFetchingNextPage}
                    hasMore={homePlanFoodSearch.hasMore}
                    loadMoreText="加载更多食物"
                    loadingMoreText="正在加载更多食物..."
                    options={homePlanFoodSearch.foods.map((food) => {
                      const cover = getFoodCover(food, props.recipes);
                      return {
                        id: food.id,
                        label: food.name,
                        description: [
                          FOOD_TYPE_LABELS[food.type],
                          food.source_name || food.purchase_source || food.category,
                          food.recipe_id ? '可开始做' : '可记到今天',
                        ]
                          .filter(Boolean)
                          .join(' · '),
                        image: <MediaWithPlaceholder src={props.resolveAssetUrl(cover)} alt="" />,
                      };
                    })}
                    emptyText={homePlanFoodSearch.isSearching ? '正在搜索...' : '没有找到匹配的食物'}
                    onSearchCompositionStart={homePlanFoodSearch.onCompositionStart}
                    onSearchCompositionEnd={homePlanFoodSearch.onCompositionEnd}
                    onQueryChange={props.setHomePlanAddFoodSearch}
                    onLoadMore={() => {
                      if (homePlanFoodSearch.hasMore && !homePlanFoodSearch.isFetchingNextPage) {
                        void homePlanFoodSearch.fetchNextPage();
                      }
                    }}
                    onChange={(foodId) => {
                      const food = homePlanFoodSearch.findFoodById(foodId);
                      if (food) props.selectHomePlanAddFood(food);
                    }}
                  />
                </div>
              )}

              <div className="recipe-plan-form-row">
                <label className="recipe-plan-date-field">
                  <span>计划日期</span>
                  <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
                    {props.dashboardPlanDays.map((day) => (
                      <button
                        key={day.date}
                        type="button"
                        className={props.homePlanAddForm.planDate === day.date ? 'active' : ''}
                        aria-pressed={props.homePlanAddForm.planDate === day.date}
                        onClick={() => props.setHomePlanAddForm((current) => ({ ...current, planDate: day.date }))}
                      >
                        <span>{day.isToday ? '今天' : `周${day.weekday}`}</span>
                        <strong>{day.date.slice(5).replace('-', '/')}</strong>
                      </button>
                    ))}
                  </div>
                </label>
                <label className="recipe-plan-meal-field">
                  <span>餐次</span>
                  <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
                    {DASHBOARD_PLAN_MEAL_TYPES.map((mealType) => (
                      <button
                        key={mealType}
                        type="button"
                        className={props.homePlanAddForm.mealType === mealType ? 'active' : ''}
                        aria-pressed={props.homePlanAddForm.mealType === mealType}
                        onClick={() => props.setHomePlanAddForm((current) => ({ ...current, mealType }))}
                      >
                        {MEAL_TYPE_LABELS[mealType]}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <label className="recipe-plan-note-field">
                <span>备注</span>
                <input
                  className="text-input"
                  value={props.homePlanAddForm.note}
                  placeholder="比如：少油、常点套餐、提前解冻"
                  onChange={(event) => props.setHomePlanAddForm((current) => ({ ...current, note: event.target.value }))}
                />
              </label>
            </form>
          </WorkspaceModal>
        </div>
      )}

      {props.homeMealEnrichmentMeal && props.homeMealEnrichmentSource && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.closeHomeMealEnrichment} />
          <WorkspaceModal
            title="补充记录"
            description="为这次菜单安排添加评价、家人、照片和评论。"
            className="meal-log-modal meal-log-enrich-modal"
            closeAriaLabel="关闭"
            onClose={props.closeHomeMealEnrichment}
            footerInfo={<span>保存后，本次补充记录将会出现在记录时间线中</span>}
            footerActions={
              <FormActions
                className="meal-enrichment-actions"
                primaryLabel="保存记录"
                primaryType="submit"
                primaryForm={homeMealEnrichmentFormId}
                isSubmitting={props.isUpdatingMeal}
                secondaryLabel="稍后再说"
                onSecondary={props.closeHomeMealEnrichment}
              />
            }
          >
            <MealEnrichmentForm
              formId={homeMealEnrichmentFormId}
              showFooter={false}
              meal={props.homeMealEnrichmentMeal}
              members={props.homeMealEnrichmentMembers}
              source={props.homeMealEnrichmentSource}
              isUpdating={props.isUpdatingMeal}
              updateMealLog={props.updateMealLog}
              requireMeaningfulInput={props.homeMealEnrichmentMeal.id.startsWith('draft-')}
              onInvalidSave={props.onInvalidMealEnrichmentSave}
              onCancel={props.closeHomeMealEnrichment}
              onSaved={props.closeHomeMealEnrichment}
            />
          </WorkspaceModal>
        </div>
      )}

      {homeExpiryReviewItem && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.closeHomeExpiryReview} />
          <WorkspaceModal
            title="处理临期食材"
            description="先核对这批库存的信息；需要调整数量、位置或继续处理时进入食材详情。"
            className="dashboard-todo-modal"
            onClose={props.closeHomeExpiryReview}
            footerActions={
              <FormActions
                className="dashboard-todo-actions"
                primaryLabel="查看食材详情"
                secondaryLabel="关闭"
                onPrimary={() => {
                  const ingredientId = homeExpiryReviewItem.ingredient_id;
                  props.closeHomeExpiryReview();
                  props.openIngredientDetail(ingredientId);
                }}
                onSecondary={props.closeHomeExpiryReview}
              />
            }
          >
            <div className="dashboard-todo-dialog">
              <section className="dashboard-todo-dialog-hero">
                <div className="dashboard-todo-dialog-media">
                  <MediaWithPlaceholder
                    src={props.resolveAssetUrl(props.homeExpiryReviewIngredient?.image?.url)}
                    alt={props.homeExpiryReviewIngredient?.name ?? homeExpiryReviewItem.ingredient_name}
                  />
                </div>
                <div className="dashboard-todo-dialog-copy">
                  <Badge className={homeExpiryReviewItem.daysLeft <= 1 ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                    {homeExpiryReviewItem.daysLeft <= 0 ? '今天到期' : formatRelativeDays(homeExpiryReviewItem.expiry_date ?? today)}
                  </Badge>
                  <h3>{homeExpiryReviewItem.ingredient_name}</h3>
                  <p>
                    {props.homeExpiryReviewIngredient?.category || '未分类'} · {homeExpiryReviewItem.storage_location || '未记录位置'}
                  </p>
                </div>
              </section>

              <div className="dashboard-todo-dialog-grid">
                <article>
                  <span>剩余数量</span>
                  <strong>
                    {homeExpiryReviewItem.remaining_quantity ?? homeExpiryReviewItem.quantity}
                    {homeExpiryReviewItem.unit}
                  </strong>
                </article>
                <article>
                  <span>库存状态</span>
                  <strong>{INVENTORY_STATUS_LABELS[homeExpiryReviewItem.status]}</strong>
                </article>
                <article>
                  <span>购买日期</span>
                  <strong>{formatDate(homeExpiryReviewItem.purchase_date)}</strong>
                </article>
                <article>
                  <span>到期日期</span>
                  <strong>{homeExpiryReviewItem.expiry_date ? formatDate(homeExpiryReviewItem.expiry_date) : '未记录'}</strong>
                </article>
              </div>

              {homeExpiryReviewItem.notes && <p className="dashboard-todo-dialog-note">{homeExpiryReviewItem.notes}</p>}

            </div>
          </WorkspaceModal>
        </div>
      )}

      {props.homeMealDetail && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.closeHomeMealDetail} />
          <WorkspaceModal
            title="餐食详情"
            description="这条今日待办已经完成，下面是本餐记录。"
            className="dashboard-todo-modal meal-detail-modal"
            onClose={props.closeHomeMealDetail}
            footerActions={
              <FormActions
                className="dashboard-todo-actions"
                primaryLabel="知道了"
                onPrimary={props.closeHomeMealDetail}
              />
            }
          >
            <div className="dashboard-todo-dialog meal-detail-dialog">
              <section className="meal-detail-head">
                <div>
                  <Badge className="dashboard-done-badge">已完成</Badge>
                  <h3>{MEAL_TYPE_LABELS[props.homeMealDetail.meal_type]}</h3>
                  <p>{formatDate(props.homeMealDetail.date)} · {formatDateTime(props.homeMealDetail.created_at)}</p>
                </div>
                {props.homeMealDetail.mood && <strong>{props.homeMealDetail.mood}</strong>}
              </section>

              <section className="meal-detail-section">
                <span>本餐食物</span>
                <div className="meal-detail-food-list">
                  {props.homeMealDetail.food_entries.length > 0 ? (
                    props.homeMealDetail.food_entries.map((entry) => (
                      <article key={entry.id} className="meal-detail-food-item">
                        <div>
                          <strong>{entry.food_name}</strong>
                          {entry.note && <p>{entry.note}</p>}
                        </div>
                        <Badge>{entry.servings} 份</Badge>
                      </article>
                    ))
                  ) : (
                    <p className="subtle">这餐没有关联具体食物。</p>
                  )}
                </div>
              </section>

              <section className="meal-detail-section">
                <span>参与成员</span>
                <div className="meal-detail-member-row">
                  {props.homeMealDetailParticipants.length > 0 ? (
                    props.homeMealDetailParticipants.map((member) => (
                      <span key={member.id} className="meal-detail-member">
                        <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} />
                        {member.display_name}
                      </span>
                    ))
                  ) : (
                    <p className="subtle">未记录参与成员。</p>
                  )}
                </div>
              </section>

              {props.homeMealDetail.notes && (
                <section className="meal-detail-section">
                  <span>备注</span>
                  <p className="meal-detail-note">{props.homeMealDetail.notes}</p>
                </section>
              )}

              {props.homeMealDetail.photos.length > 0 && (
                <section className="meal-detail-section">
                  <span>照片</span>
                  <div className="meal-detail-photo-grid">
                    {props.homeMealDetail.photos.map((photo) => (
                      <MediaWithPlaceholder
                        key={photo.id}
                        src={props.resolveAssetUrl(photo.url)}
                        alt={photo.alt || photo.name}
                      />
                    ))}
                  </div>
                </section>
              )}

            </div>
          </WorkspaceModal>
        </div>
      )}

      {homeRestockShoppingItem && homeRestockForm && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.closeHomeRestock} />
          <WorkspaceModal
            title="登记这批库存"
            description="从首页采购提醒快速入库，保存后会把这条采购项标记完成。"
            closeLabel="关闭"
            closeAriaLabel="关闭"
            className="workspace-modal-wide inventory-restock-modal"
            onClose={props.closeHomeRestock}
            footerActions={
              <FormActions
                className="ingredients-restock-actions"
                primaryLabel="补入库存"
                primaryType="submit"
                primaryForm={homeRestockFormId}
                primaryDisabled={!props.homeRestockIngredient}
                isSubmitting={props.isCreatingInventory}
                secondaryLabel="取消"
                onSecondary={props.closeHomeRestock}
              />
            }
          >
            <form id={homeRestockFormId} className="ingredients-restock-form" onSubmit={(event) => void props.submitHomeRestock(event)}>
              <div className="ingredients-restock-scroll">
                <div className="ingredients-restock-source-note">
                  <Badge>来自采购提醒</Badge>
                  <span>{homeRestockShoppingItem.title}</span>
                </div>

                <section className="ingredients-restock-field-group">
                  <div className="ingredients-restock-field-head">
                    <span>识别食材</span>
                    <p className="subtle">优先匹配已有档案，也可以更换为其他已有食材。</p>
                  </div>
                  {props.homeRestockIngredient ? (
                    <div className="ingredients-restock-matched-card">
                      <div className="ingredients-restock-matched-media">
                        <MediaWithPlaceholder
                          src={props.homeRestockIngredientImageUrl}
                          alt={props.homeRestockIngredient.name}
                        />
                      </div>
                      <div className="ingredients-restock-matched-info">
                        <strong>{props.homeRestockIngredient.name}</strong>
                        <span>
                          {props.homeRestockIngredient.category || '未分类'} · 默认存放在 {props.homeRestockIngredient.default_storage || '未设置'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="ingredients-restock-change-btn"
                        onClick={() => setShowIngredientSelector(!showIngredientSelector)}
                      >
                        {showIngredientSelector ? '收起' : '更换'}
                      </button>
                    </div>
                  ) : (
                    <div className="ingredients-restock-matched-card is-empty">
                      <div className="ingredients-restock-matched-media">
                        <span>?</span>
                      </div>
                      <div className="ingredients-restock-matched-info">
                        <strong>未选择食材</strong>
                        <span>请选择对应食材以继续登记</span>
                      </div>
                      <button
                        type="button"
                        className="ingredients-restock-change-btn is-action"
                        onClick={() => setShowIngredientSelector(!showIngredientSelector)}
                      >
                        {showIngredientSelector ? '收起' : '选择食材'}
                      </button>
                    </div>
                  )}

                  {showIngredientSelector && (
                    <div className="ingredients-restock-search-field ingredients-restock-selector-panel">
                      <span>食材</span>
                      <SearchableResourceSelect
                        ariaLabel="选择食材"
                        placeholder="搜索现有食材..."
                        value={homeRestockForm.ingredientId}
                        query={homeRestockForm.ingredientQuery}
                        loading={homeRestockIngredientSearch.isSearching}
                        loadingMore={homeRestockIngredientSearch.isFetchingNextPage}
                        hasMore={homeRestockIngredientSearch.hasMore}
                        loadMoreText="加载更多食材"
                        loadingMoreText="正在加载更多食材..."
                        options={homeRestockIngredientSearch.ingredients
                          .map((ingredient) => ({
                            id: ingredient.id,
                            label: ingredient.name,
                            description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
                            image: <MediaWithPlaceholder src={resolveMediaUrl(ingredient.image, 'thumb')} alt="" />,
                          }))}
                        emptyText={homeRestockIngredientSearch.isSearching ? '正在搜索...' : '没有找到匹配的食材'}
                        onSearchCompositionStart={homeRestockIngredientSearch.onCompositionStart}
                        onSearchCompositionEnd={homeRestockIngredientSearch.onCompositionEnd}
                        onQueryChange={updateHomeRestockIngredientQuery}
                        onLoadMore={() => {
                          if (homeRestockIngredientSearch.hasMore && !homeRestockIngredientSearch.isFetchingNextPage) {
                            void homeRestockIngredientSearch.fetchNextPage();
                          }
                        }}
                        onChange={(ingredientId) => {
                          const ingredient = homeRestockIngredientSearch.findIngredientById(ingredientId);
                          if (ingredient) selectHomeRestockIngredient(ingredient);
                        }}
                      />
                    </div>
                  )}
                </section>

                <section className="ingredients-restock-field-group">
                  <div className="form-grid compact-grid">
                    <label>
                      <span>数量</span>
                      <input
                        className="text-input"
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={homeRestockForm.quantity}
                        onChange={(event) => props.updateHomeRestockForm({ ...homeRestockForm, quantity: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>单位</span>
                      <input
                        className="text-input"
                        value={homeRestockForm.unit}
                        onChange={(event) => props.updateHomeRestockForm({ ...homeRestockForm, unit: event.target.value })}
                      />
                    </label>
                  </div>
                </section>

                <section className="ingredients-restock-field-group">
                  <div className="ingredients-restock-field-head">
                    <span>购买时间</span>
                    <p className="subtle">默认今天，需要时再改。</p>
                  </div>
                  <OptionChipGroup
                    ariaLabel="购买时间"
                    value={homeRestockForm.purchaseDate}
                    options={[
                      { value: today, label: '今天' },
                      { value: addDateKeyDays(today, -1), label: '昨天' },
                    ]}
                    className="ingredients-restock-choice-row"
                    onChange={(purchaseDate) =>
                      props.updateHomeRestockForm({
                        ...homeRestockForm,
                        purchaseDate,
                        expiryDate:
                          homeRestockForm.expiryInputMode === 'days'
                            ? resolveExpiryDateFromDays(purchaseDate, homeRestockForm.expiryDays)
                            : homeRestockForm.expiryDate,
                      })
                    }
                  />
                  <label>
                    <span>购买日期</span>
                    <input
                      className="text-input"
                      type="date"
                      value={homeRestockForm.purchaseDate}
                      onChange={(event) =>
                        props.updateHomeRestockForm({
                          ...homeRestockForm,
                          purchaseDate: event.target.value,
                          expiryDate:
                            homeRestockForm.expiryInputMode === 'days'
                              ? resolveExpiryDateFromDays(event.target.value, homeRestockForm.expiryDays)
                              : homeRestockForm.expiryDate,
                        })
                      }
                    />
                  </label>
                </section>

                <section className="ingredients-restock-field-group">
                  <div className="ingredients-restock-field-head">
                    <span>存放位置</span>
                    <p className="subtle">按这次实际放的位置点一下。</p>
                  </div>
                  <OptionChipGroup
                    ariaLabel="存放位置"
                    value={homeRestockForm.storageLocation}
                    options={['冷藏', '冷冻', '常温'].map((storage) => ({ value: storage, label: storage }))}
                    className="ingredients-restock-choice-row"
                    onChange={(storageLocation) =>
                      props.updateHomeRestockForm({
                        ...homeRestockForm,
                        storageLocation,
                        status: resolveInventoryStatusForStorage(storageLocation),
                      })
                    }
                  />
                  <input
                    className="text-input"
                    placeholder="自定义位置"
                    value={homeRestockForm.storageLocation}
                    onChange={(event) =>
                      props.updateHomeRestockForm({
                        ...homeRestockForm,
                        storageLocation: event.target.value,
                        status: resolveInventoryStatusForStorage(event.target.value),
                      })
                    }
                  />
                </section>

                <section className="ingredients-restock-field-group">
                  <div className="ingredients-restock-field-head">
                    <span>到期信息</span>
                    <p className="subtle">确认这批食材怎么跟踪到期。</p>
                  </div>
                  <OptionChipGroup
                    ariaLabel="到期信息"
                    value={homeRestockForm.expiryInputMode}
                    options={[
                      { value: 'none', label: '不记录' },
                      { value: 'days', label: '几天后到期' },
                      { value: 'manual_date', label: '包装到期日' },
                    ]}
                    className="ingredients-restock-choice-row"
                    onChange={(value) => {
                      const nextMode = value as HomeRestockFormState['expiryInputMode'];
                      const nextDays = nextMode === 'days' ? homeRestockForm.expiryDays || '3' : '';
                      props.updateHomeRestockForm({
                        ...homeRestockForm,
                        expiryInputMode: nextMode,
                        expiryDays: nextDays,
                        expiryDate:
                          nextMode === 'days'
                            ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, nextDays)
                            : nextMode === 'manual_date'
                              ? homeRestockForm.expiryDate
                              : '',
                      });
                    }}
                  />
                  {homeRestockForm.expiryInputMode === 'days' && (
                    <div className="form-grid compact-grid">
                      <label>
                        <span>买后几天到期</span>
                        <input
                          className="text-input"
                          type="number"
                          min="1"
                          value={homeRestockForm.expiryDays}
                          onChange={(event) =>
                            props.updateHomeRestockForm({
                              ...homeRestockForm,
                              expiryDays: event.target.value,
                              expiryDate: resolveExpiryDateFromDays(homeRestockForm.purchaseDate, event.target.value),
                            })
                          }
                        />
                      </label>
                      <div className="ingredients-restock-result-card">
                        <span>预计到期日</span>
                        <strong>{homeRestockForm.expiryDate ? formatDate(homeRestockForm.expiryDate) : '先填天数'}</strong>
                        <p>{homeRestockForm.purchaseDate} 购入</p>
                      </div>
                    </div>
                  )}
                  {homeRestockForm.expiryInputMode === 'manual_date' && (
                    <label>
                      <span>包装到期日</span>
                      <input
                        className="text-input"
                        type="date"
                        value={homeRestockForm.expiryDate}
                        onChange={(event) => props.updateHomeRestockForm({ ...homeRestockForm, expiryDate: event.target.value })}
                      />
                    </label>
                  )}
                </section>

                <section className="ingredients-modal-advanced">
                  <div className="ingredients-modal-advanced-fields">
                    <div className="ingredients-restock-status-custom-field">
                      <span>状态</span>
                      <DropdownSelect
                        ariaLabel="选择状态"
                        placeholder="选择状态"
                        value={homeRestockForm.status}
                        options={statusOptions}
                        onChange={(val) =>
                          props.updateHomeRestockForm({ ...homeRestockForm, status: val as InventoryStatus })
                        }
                      />
                    </div>
                    <label className="span-two">
                      <span>备注</span>
                      <textarea
                        className="text-input"
                        rows={3}
                        value={homeRestockForm.notes}
                        onChange={(event) => props.updateHomeRestockForm({ ...homeRestockForm, notes: event.target.value })}
                      />
                    </label>
                  </div>
                </section>
              </div>

            </form>
          </WorkspaceModal>
        </div>
      )}

      {props.homeExpiredDisposalSummary && (
        <div className="workspace-overlay-root home-dashboard-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => props.setHomeExpiredDisposalIngredientId(null)} />
          <WorkspaceModal
            title="销毁已过期批次"
            description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
            closeLabel="关闭"
            closeAriaLabel="关闭"
            className="workspace-modal-wide destroy-expired-modal"
            onClose={() => props.setHomeExpiredDisposalIngredientId(null)}
            footerInfo={
              <div className="destroy-expired-footer-summary">
                <span>确认后将处理</span>
                <strong>{props.homeExpiredDisposalItems.length} 条过期批次</strong>
                <p>
                  {props.homeExpiredDisposalItems.length > 0
                    ? '系统会把这些批次的剩余量清零，并在刷新后同步库存状态。'
                    : '当前没有可销毁的过期批次。'}
                </p>
              </div>
            }
            footerActions={
              <FormActions
                className="destroy-expired-actions"
                primaryLabel="确认销毁"
                primaryType="submit"
                primaryForm={homeExpiredDisposalFormId}
                primaryDisabled={props.homeExpiredDisposalItems.length === 0}
                isSubmitting={props.isDisposingExpiredInventory}
                secondaryLabel="取消"
                onSecondary={() => props.setHomeExpiredDisposalIngredientId(null)}
              />
            }
          >
            <form id={homeExpiredDisposalFormId} className="destroy-expired-form" onSubmit={(event) => void props.submitHomeExpiredDisposal(event)}>
              <div className="destroy-expired-scroll">
                <section className="ingredients-restock-identity-card destroy-expired-summary-card">
                  <div className="ingredients-restock-identity-media">
                    <MediaWithPlaceholder
                      src={props.resolveAssetUrl(props.homeExpiredDisposalSummary.ingredient.image?.url)}
                      alt={props.homeExpiredDisposalSummary.ingredient.name}
                    />
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{props.homeExpiredDisposalSummary.ingredient.name}</h4>
                        <p>{props.homeExpiredDisposalSummary.ingredient.category || '未分类'} · {props.homeExpiredDisposalSummary.primaryStorage}</p>
                      </div>
                      <div className="destroy-expired-summary-badges">
                        <Badge>{props.homeExpiredDisposalItems.length} 条待销毁</Badge>
                        <Badge>{props.homeExpiredDisposalSummary.quantitySummaries[0]?.label ?? '当前已空'}</Badge>
                      </div>
                    </div>
                    <div className="destroy-expired-summary-grid">
                      <article className="destroy-expired-summary-metric is-primary">
                        <span>本次处理范围</span>
                        <strong>{props.homeExpiredDisposalItems.length} 条过期批次</strong>
                        <p>仅包含已经过期且当前仍有剩余量的批次。</p>
                      </article>
                      <article className="destroy-expired-summary-metric">
                        <span>处理结果</span>
                        <strong>清零剩余量</strong>
                        <p>批次记录、备注和活动日志都会继续保留。</p>
                      </article>
                    </div>
                  </div>
                </section>

                <section className="ingredients-restock-field-group destroy-expired-list-section">
                  <div className="ingredients-restock-field-head">
                    <span>将要销毁的批次</span>
                    <p className="subtle">只列出到期日早于今天的剩余批次；今天到期和未来到期不会出现在这里。</p>
                  </div>
                  {props.homeExpiredDisposalItems.length > 0 ? (
                    <div className="destroy-expired-list">
                      {props.homeExpiredDisposalItems.map((item) => {
                        const expiredDays = Math.abs(getExpiryDaysLeft(item.expiryDate, today));
                        return (
                          <article key={item.id} className="destroy-expired-row">
                            <div className="destroy-expired-row-main">
                              <strong>{item.remainingLabel}</strong>
                              <span>{item.storageLocation}</span>
                            </div>
                            <div className="destroy-expired-row-meta">
                              <span className="is-danger">已过期 {expiredDays} 天</span>
                              <span>{INVENTORY_STATUS_LABELS[item.status]}</span>
                              <span>购 {formatDate(item.purchaseDate)}</span>
                              <span>到期 {formatDate(item.expiryDate)}</span>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState
                      title="当前没有可销毁的批次"
                      description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
                    />
                  )}
                </section>
              </div>

            </form>
          </WorkspaceModal>
        </div>
      )}
    </>
  );
}

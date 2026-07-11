import { useEffect, useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  MealLog,
  Member,
  Recipe,
  ShoppingListItem,
  UpdateMealLogPayload,
} from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import {
  FoodPlanDateMealNoteFields,
  FoodPlanFoodPicker,
  FoodPlanSelectedHero,
} from '../../components/foods/FoodPlanDialogParts';
import {
  IngredientRestockAdvancedSection,
  IngredientRestockExpirySection,
  IngredientRestockPurchaseSection,
  IngredientRestockQuantitySection,
  IngredientRestockStorageSection,
  resolvePurchaseDatePatch,
} from '../../components/ingredients/IngredientRestockSections';
import {
  parsePositiveNumber,
  resolveClampedDaysValue,
  type InventoryPurchasePreset,
} from '../../components/ingredients/ingredientWorkspaceForms';
import {
  InventoryActionDialog,
} from '../inventory/InventoryActionDialog';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import type { VersionedInventoryItemRef } from '../../api/types';
import type { HomeActionCompletionSummary } from './useHomeDashboardState';
import { Avatar, Badge, FormActions, SearchableResourceSelect, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { resolveMediaUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { convertQuantityToDefaultUnit, getIngredientUnitOptions } from '../../lib/ingredientUnits';
import { useFoodResourceSearch } from '../../hooks/useFoodResourceSearch';
import { useIngredientResourceSearch } from '../../hooks/useIngredientResourceSearch';
import {
  FOOD_TYPE_LABELS,
  formatDate,
  formatDateTime,
  getFoodCover,
  MEAL_TYPE_LABELS,
  todayKey,
} from '../../lib/ui';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  matchIngredientByExactName,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
  type DashboardPlanDay,
  type HomeRestockFormState,
} from './homeDashboardModel';
import type { HomePlanAddFormState } from './useHomeDashboardState';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';
import type { MealSource } from '../meals/MealLogEnrichment';

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
  selectedActionGroup: InventoryActionGroup | null;
  businessDateKey: string;
  actionDialogBusy: boolean;
  actionDialogError: string | null;
  actionDialogConflict: 'none' | 'review_again';
  closeActionGroup: () => void;
  disposeSelectedInventoryBatches: (items: VersionedInventoryItemRef[]) => Promise<void>;
  snoozeSelectedInventoryAlerts: (args: {
    action: 'retain_expired' | 'snooze_upcoming';
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) => Promise<void>;
  correctSelectedInventoryExpiryDate: (args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) => Promise<void>;
  completionSummary: HomeActionCompletionSummary | null;
  nextGroupId: string | null;
  nextGroupLabel: string | null;
  openNextActionGroup: () => void;
  dismissCompletionSummary: () => void;
  onCompletionSecondaryAction: (ingredientId: string) => void;
  resolveAssetUrl: (url?: string) => string | undefined;
};

export function HomeDashboardDialogs(props: Props) {
  const today = todayKey();
  const homePlanDetailItem = props.homePlanDetailItem;
  const homeRestockShoppingItem = props.homeRestockShoppingItem;
  const selectedExpiryGroup =
    props.selectedActionGroup && props.selectedActionGroup.kind === 'expiry'
      ? (props.selectedActionGroup as ExpiryInventoryActionGroup)
      : null;
  const homeRestockForm = props.homeRestockForm;
  const homePlanAddFormId = 'home-plan-add-overlay-form';
  const homeRestockFormId = 'home-restock-overlay-form';

  const [showIngredientSelector, setShowIngredientSelector] = useState(false);
  const homeRestockIngredientSearch = useIngredientResourceSearch(homeRestockForm?.ingredientQuery ?? '', {
    enabled: Boolean(homeRestockShoppingItem && homeRestockForm && showIngredientSelector),
    fallbackIngredients: props.ingredients,
  });
  const homePlanFoodSearch = useFoodResourceSearch(props.homePlanAddFoodSearch, {
    enabled: props.isHomePlanAddDialogOpen && !props.homePlanAddFood,
    fallbackFoods: props.homePlanAddFoodOptions,
  });
  const homeRestockUnitOptions = useMemo(() => {
    const currentUnit = homeRestockForm?.unit || props.homeRestockIngredient?.default_unit || '个';
    const units = props.homeRestockIngredient
      ? [currentUnit, ...getIngredientUnitOptions(props.homeRestockIngredient).map((option) => option.unit)]
      : [currentUnit];
    return units
      .filter((unit, index, list) => unit && list.indexOf(unit) === index)
      .map((unit) => ({ value: unit, label: unit }));
  }, [homeRestockForm?.unit, props.homeRestockIngredient]);
  const homeRestockSelectedUnit =
    props.homeRestockIngredient && homeRestockForm
      ? getIngredientUnitOptions(props.homeRestockIngredient).find((item) => item.unit === homeRestockForm.unit) ??
        { unit: homeRestockForm.unit || props.homeRestockIngredient.default_unit || '个' }
      : null;
  const homeRestockNormalizedQuantity =
    props.homeRestockIngredient && homeRestockForm
      ? (() => {
          const parsedQuantity = parsePositiveNumber(homeRestockForm.quantity);
          return parsedQuantity !== null
            ? convertQuantityToDefaultUnit(props.homeRestockIngredient, parsedQuantity, homeRestockForm.unit)
            : null;
        })()
      : null;
  const homePurchaseDatePreset: InventoryPurchasePreset =
    homeRestockForm?.purchaseDate === today
      ? 'today'
      : homeRestockForm?.purchaseDate === addDateKeyDays(today, -1)
        ? 'yesterday'
        : 'custom';
  const homeRestockExpiryDaysValue = homeRestockForm
    ? resolveClampedDaysValue(homeRestockForm.expiryDays, props.homeRestockIngredient?.default_expiry_days ?? 3)
    : 3;

  useEffect(() => {
    setShowIngredientSelector(false);
  }, [homeRestockShoppingItem?.id]);

  const closeHomePlanAddDialogIfAllowed = () => {
    if (!props.isCreatingFoodPlanItem) {
      props.closeHomePlanAddDialog();
    }
  };

  const closeHomeRestockIfAllowed = () => {
    if (!props.isCreatingInventory) {
      props.closeHomeRestock();
    }
  };

  function updateHomeRestockIngredientQuery(query: string) {
    if (!homeRestockForm) return;
    const normalizedQuery = query.trim();
    const match = normalizedQuery
      ? homeRestockIngredientSearch.findIngredientByName(normalizedQuery)
        ?? matchIngredientByExactName(normalizedQuery, props.ingredients)
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
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={closeHomePlanAddDialogIfAllowed}
          closeOnBackdrop={!props.isCreatingFoodPlanItem}
        >
          <WorkspaceModal
            title="加食物到菜单"
            description="选择日期和餐次后加入当前周菜单。"
            eyebrow="菜单计划"
            onClose={closeHomePlanAddDialogIfAllowed}
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
                onSecondary={closeHomePlanAddDialogIfAllowed}
              />
            }
          >
            <form id={homePlanAddFormId} className="recipe-plan-dialog-form" onSubmit={(event) => void props.submitHomePlanAdd(event)}>
              {props.homePlanAddFood ? (
                <FoodPlanSelectedHero
                  food={props.homePlanAddFood}
                  coverUrl={props.resolveAssetUrl(getFoodCover(props.homePlanAddFood, props.recipes))}
                  typeLabel={FOOD_TYPE_LABELS[props.homePlanAddFood.type]}
                  sourceLabel={
                    props.homePlanAddFood.source_name ||
                    props.homePlanAddFood.purchase_source ||
                    props.homePlanAddFood.category ||
                    '常吃食物'
                  }
                  capabilityLabel={props.homePlanAddFood.recipe_id ? '有菜谱' : '可直接记录'}
                  iconKind={props.homePlanAddFood.recipe_id ? 'bookOpen' : 'clipboard'}
                  onClear={() => props.setHomePlanAddFoodId(null)}
                />
              ) : (
                <FoodPlanFoodPicker
                  searchInputId="home-food-plan-search"
                  value=""
                  query={props.homePlanAddFoodSearch}
                  loading={homePlanFoodSearch.isSearching}
                  loadingMore={homePlanFoodSearch.isFetchingNextPage}
                  hasMore={homePlanFoodSearch.hasMore}
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
                  onCompositionStart={homePlanFoodSearch.onCompositionStart}
                  onCompositionEnd={homePlanFoodSearch.onCompositionEnd}
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
              )}

              <FoodPlanDateMealNoteFields
                planDate={props.homePlanAddForm.planDate}
                mealType={props.homePlanAddForm.mealType}
                note={props.homePlanAddForm.note}
                todayDate={today}
                planDateOptions={props.dashboardPlanDays.map((day) => ({
                  value: day.date,
                  label: day.isToday ? '今天' : `周${day.weekday}`,
                  display: day.date.slice(5).replace('-', '/'),
                }))}
                mealOptions={DASHBOARD_PLAN_MEAL_TYPES.map((value) => ({ value, label: MEAL_TYPE_LABELS[value] }))}
                notePlaceholder="比如：少油、常点套餐、提前解冻"
                onPlanDateChange={(planDate) => props.setHomePlanAddForm((current) => ({ ...current, planDate }))}
                onMealTypeChange={(mealType) => props.setHomePlanAddForm((current) => ({ ...current, mealType }))}
                onPlanNoteChange={(note) => props.setHomePlanAddForm((current) => ({ ...current, note }))}
              />
            </form>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      <MealEnrichmentModal
        open={Boolean(props.homeMealEnrichmentMeal && props.homeMealEnrichmentSource)}
        meal={props.homeMealEnrichmentMeal}
        source={props.homeMealEnrichmentSource}
        members={props.homeMealEnrichmentMembers}
        isUpdating={props.isUpdatingMeal}
        updateMealLog={props.updateMealLog}
        requireMeaningfulInput={props.homeMealEnrichmentMeal?.id.startsWith('draft-')}
        onInvalidSave={props.onInvalidMealEnrichmentSave}
        onClose={props.closeHomeMealEnrichment}
        overlayRootClassName="home-dashboard-overlay-root"
        formId="home-meal-enrichment-overlay-form"
      />

      {props.homeMealDetail && (
        <WorkspaceOverlayFrame rootClassName="home-dashboard-overlay-root" onClose={props.closeHomeMealDetail}>
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
        </WorkspaceOverlayFrame>
      )}

      {homeRestockShoppingItem && homeRestockForm && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={closeHomeRestockIfAllowed}
          closeOnBackdrop={!props.isCreatingInventory}
        >
          <WorkspaceModal
            title="登记这批库存"
            description="从首页采购提醒快速入库，保存后会把这条采购项标记完成。"
            closeLabel="关闭"
            closeAriaLabel="关闭"
            className="workspace-modal-wide inventory-restock-modal"
            onClose={closeHomeRestockIfAllowed}
            footerActions={
              <FormActions
                className="ingredients-restock-actions"
                primaryLabel="补入库存"
                primaryType="submit"
                primaryForm={homeRestockFormId}
                primaryDisabled={!props.homeRestockIngredient}
                isSubmitting={props.isCreatingInventory}
                secondaryLabel="取消"
                onSecondary={closeHomeRestockIfAllowed}
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

                <IngredientRestockQuantitySection
                  ingredient={props.homeRestockIngredient}
                  quantity={homeRestockForm.quantity}
                  unit={homeRestockForm.unit || props.homeRestockIngredient?.default_unit || '个'}
                  unitOptions={homeRestockUnitOptions}
                  selectedUnit={homeRestockSelectedUnit}
                  normalizedQuantity={homeRestockNormalizedQuantity}
                  onQuantityChange={(quantity) => props.updateHomeRestockForm({ ...homeRestockForm, quantity })}
                  onUnitChange={(unit) => props.updateHomeRestockForm({ ...homeRestockForm, unit })}
                />

                <IngredientRestockPurchaseSection
                  purchaseDate={homeRestockForm.purchaseDate}
                  purchaseDatePreset={homePurchaseDatePreset}
                  onChange={(patch) => {
                    const resolvedPatch = resolvePurchaseDatePatch(patch);
                    const purchaseDate = resolvedPatch.purchaseDate ?? homeRestockForm.purchaseDate;
                    props.updateHomeRestockForm({
                      ...homeRestockForm,
                      purchaseDate,
                      expiryDate:
                        homeRestockForm.expiryInputMode === 'days'
                          ? resolveExpiryDateFromDays(purchaseDate, homeRestockForm.expiryDays)
                          : homeRestockForm.expiryDate,
                    });
                  }}
                />

                <IngredientRestockStorageSection
                  storageLocation={homeRestockForm.storageLocation}
                  onChange={(storageLocation) =>
                    props.updateHomeRestockForm({
                      ...homeRestockForm,
                      storageLocation,
                      status: resolveInventoryStatusForStorage(storageLocation),
                    })
                  }
                />

                <IngredientRestockExpirySection
                  expiryInputMode={homeRestockForm.expiryInputMode}
                  expiryDays={homeRestockForm.expiryDays}
                  expiryDate={homeRestockForm.expiryDate}
                  purchaseDate={homeRestockForm.purchaseDate}
                  defaultExpiryDays={props.homeRestockIngredient?.default_expiry_days}
                  expiryDaysValue={homeRestockExpiryDaysValue}
                  onChange={(patch) => {
                    const expiryDays = patch.expiryDays ?? homeRestockForm.expiryDays;
                    props.updateHomeRestockForm({
                      ...homeRestockForm,
                      ...patch,
                      expiryDate:
                        patch.expiryDays && homeRestockForm.expiryInputMode === 'days'
                          ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, expiryDays)
                          : patch.expiryDate ?? homeRestockForm.expiryDate,
                    });
                  }}
                />

                <IngredientRestockAdvancedSection
                  open
                  showToggle={false}
                  status={homeRestockForm.status}
                  notes={homeRestockForm.notes}
                  onOpenChange={() => undefined}
                  onChange={(patch) => props.updateHomeRestockForm({ ...homeRestockForm, ...patch })}
                />
              </div>

            </form>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      {selectedExpiryGroup && (
        <InventoryActionDialog
          open
          group={selectedExpiryGroup}
          referenceDate={props.businessDateKey}
          busy={props.actionDialogBusy}
          errorMessage={props.actionDialogError}
          conflictState={props.actionDialogConflict}
          overlayRootClassName="home-dashboard-overlay-root"
          onClose={props.closeActionGroup}
          onDispose={props.disposeSelectedInventoryBatches}
          onSnooze={props.snoozeSelectedInventoryAlerts}
          onCorrectExpiry={props.correctSelectedInventoryExpiryDate}
        />
      )}

      {props.completionSummary && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={props.dismissCompletionSummary}
        >
          <WorkspaceModal
            title={props.completionSummary.title}
            description={props.completionSummary.message}
            className="dashboard-todo-modal home-action-completion-modal"
            onClose={props.dismissCompletionSummary}
            footerActions={
              <FormActions
                className="dashboard-todo-actions"
                primaryLabel={props.nextGroupLabel ? `处理下一项：${props.nextGroupLabel}` : '知道了'}
                onPrimary={() => {
                  if (props.nextGroupId) {
                    props.openNextActionGroup();
                    return;
                  }
                  props.dismissCompletionSummary();
                }}
                secondaryLabel={
                  props.completionSummary.secondaryActionLabel
                  ?? (props.nextGroupId ? '关闭' : undefined)
                }
                onSecondary={
                  props.completionSummary.secondaryActionIngredientId
                    ? () => {
                        const ingredientId = props.completionSummary?.secondaryActionIngredientId;
                        props.dismissCompletionSummary();
                        if (ingredientId) {
                          props.onCompletionSecondaryAction(ingredientId);
                        }
                      }
                    : props.nextGroupId
                      ? props.dismissCompletionSummary
                      : undefined
                }
              />
            }
          >
            <div className="dashboard-todo-dialog">
              <p className="subtle">{props.completionSummary.message}</p>
              {props.nextGroupLabel ? (
                <p>下一项：{props.nextGroupLabel}</p>
              ) : (
                <p className="subtle">今天没有其他需要继续处理的食材。</p>
              )}
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}
    </>
  );
}

import type { ReactNode } from 'react';
import type { Ingredient, InventoryItem, Recipe } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { businessDateKey } from '../../lib/date';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  convertQuantityToDefaultUnit,
  getInventoryConsumedQuantity,
  getInventoryRemainingQuantity,
} from '../../lib/ingredientUnits';
import {
  Badge,
  EmptyState,
  SectionHeading,
  WorkspaceSubpageShell,
} from '../ui-kit';
import { formatDate, formatDateTime, formatRelativeDays, INVENTORY_STATUS_LABELS } from '../../lib/ui';
import { formatNumericString } from './ingredientWorkspaceForms';
import type { IngredientSummaryViewModel } from './workspaceModel';

type DetailMetricItem = {
  label: string;
  value: string;
  tone: string;
  icon: string;
};

type IngredientDetailViewProps = {
  activePanelBackLabel: string;
  detailStorageLabel: string;
  detailMetricItems: DetailMetricItem[];
  selectedIngredient: IngredientSummaryViewModel;
  recipes: Recipe[];
  goBackToWorkspace: () => void;
  openInventoryOverlay: (ingredientId?: string) => void;
  openConsumeOverlay: (ingredientId: string) => void;
  openShoppingOverlay: (options?: { ingredient?: Ingredient; reason?: string }) => void;
  openEditView: (ingredient: Ingredient) => void;
  renderIcon: (name: string) => ReactNode;
  formatExpiryRuleLabel: (ingredient: Ingredient) => string;
  formatLowStockRuleLabel: (ingredient: Ingredient) => string;
};

function inventoryBatchPresentation(item: Pick<InventoryItem, 'expiry_date' | 'status'>) {
  if (item.expiry_date && item.expiry_date < businessDateKey()) {
    return { tone: 'expired', label: '已过期' } as const;
  }
  return { tone: item.status, label: INVENTORY_STATUS_LABELS[item.status] };
}

export function IngredientDetailView(props: IngredientDetailViewProps) {
  const { selectedIngredient } = props;
  const ingredient = selectedIngredient.ingredient;
  const imageUrl = resolveAssetUrl(ingredient.image?.url);
  const activeBatchesCount = selectedIngredient.availableInventoryItems.length;
  const totalBatchesCount = selectedIngredient.inventoryItems.length;
  const isOutOfStock = activeBatchesCount === 0;
  const alertBannerTone = selectedIngredient.alerts.some((alert) => alert.tone === 'danger')
    ? 'danger'
    : 'warning';

  return (
    <WorkspaceSubpageShell className="ingredients-workspace-subpage ingredients-detail-page">
      {/* 1. Header Navigation & Title Row */}
      <header className="ingredient-detail-header">
        <div className="ingredient-detail-titleblock">
          <button
            className="workspace-back-link ingredient-detail-back"
            type="button"
            onClick={props.goBackToWorkspace}
            aria-label="返回食材库"
          >
            <span className="ingredient-detail-back-arrow" aria-hidden="true">←</span>
            <span className="ingredient-detail-back-label">{props.activePanelBackLabel}</span>
          </button>

          <div className="ingredient-detail-title-line">
            <h2>{ingredient.name}</h2>
            <span className="ingredient-detail-category-chip">
              {ingredient.category || '未分类食材'}
            </span>
            <span className="ingredient-detail-storage-chip">
              {selectedIngredient.primaryStorage || ingredient.default_storage || '常温'}
            </span>
          </div>

          <p className="subtle ingredient-detail-desktop-summary">
            默认单位：<strong>{ingredient.default_unit || '个'}</strong> · 默认存放位置：<strong>{ingredient.default_storage || '常温'}</strong>
          </p>
        </div>

        <div className="ingredient-detail-header-side">
          <div className="ingredient-detail-primary-actions">
            <button
              className="ghost-button ingredient-detail-edit-action"
              type="button"
              onClick={() => props.openEditView(ingredient)}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('edit')}
              </span>
              编辑食材信息
            </button>

            <button
              className="solid-button ingredient-detail-restock-action"
              type="button"
              onClick={() => props.openInventoryOverlay(ingredient.id)}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('plus')}
              </span>
              补货
            </button>

            <button
              className="ghost-button ingredient-detail-consume-action"
              type="button"
              onClick={() => props.openConsumeOverlay(ingredient.id)}
              disabled={isOutOfStock}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('check')}
              </span>
              快速记录用量
            </button>

            <button
              className="tertiary-button ingredient-detail-shopping-action"
              type="button"
              onClick={() =>
                props.openShoppingOverlay({
                  ingredient,
                  reason: '库存偏低，准备补货',
                })
              }
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('shopping')}
              </span>
              加入采购清单
            </button>
          </div>
        </div>
      </header>

      {/* 2. Hero Section */}
      <article className="ingredient-detail-hero">
        <div className="ingredient-detail-cover-frame">
          <MediaWithPlaceholder
            className="ingredient-detail-cover"
            src={imageUrl}
            alt={ingredient.name}
          />
          <span className="ingredient-detail-cover-tag">
            {ingredient.default_storage || '常温'}
          </span>
        </div>

        <div className="ingredient-detail-copy">
          <div className="ingredient-detail-note-card">
            <span className="ingredient-detail-note-icon" aria-hidden="true">💡</span>
            <p className="ingredient-detail-note-text">
              {ingredient.notes || '还没有备注。'}
            </p>
          </div>

          <div className="ingredient-detail-metric-grid" aria-label="食材摘要指标">
            {props.detailMetricItems.map((item) => (
              <div key={item.label} className={`ingredient-detail-metric tone-${item.tone}`}>
                <span className="ingredient-detail-metric-icon" aria-hidden="true">
                  {props.renderIcon(item.icon)}
                </span>
                <span className="ingredient-detail-metric-label">{item.label}</span>
                <strong className="ingredient-detail-metric-value">{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      </article>

      {/* 3. Active Alert Banner if any */}
      {selectedIngredient.alerts.length > 0 && (
        <section
          className={`ingredient-detail-alert-banner tone-${alertBannerTone}`}
          aria-label="库存提醒"
        >
          <div className="ingredient-detail-alert-banner-head">
            <span className="ingredient-detail-alert-banner-icon" aria-hidden="true">
              {props.renderIcon('bell')}
            </span>
            <div>
              <h3>有 {selectedIngredient.alerts.length} 条库存提醒需要处理</h3>
              <p>及时补货或处理过期库存，减少食材浪费。</p>
            </div>
          </div>
          <div className="ingredient-detail-alert-pills">
            {selectedIngredient.alerts.map((alert) => (
              <div key={alert.id} className={`ingredient-detail-alert-pill tone-${alert.tone}`}>
                <strong>{alert.title}</strong>
                <span>{alert.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. Main Two-Column Grid */}
      <div className="ingredient-detail-grid">
        {/* Left Column: Inventory Batches */}
        <section className="card ingredient-detail-section ingredient-detail-section-batches">
          <SectionHeading
            title="库存"
            description={`共 ${totalBatchesCount} 批库存（${activeBatchesCount} 批可用）`}
          />
          <div className="stack-list">
            {totalBatchesCount > 0 ? (
              selectedIngredient.inventoryItems.map((item) => {
                const presentation = inventoryBatchPresentation(item);
                const isItemAvailable = presentation.tone !== 'expired';

                return (
                  <article key={item.id} className={`inventory-card inventory-card-rich tone-${presentation.tone}`}>
                    <div className="inventory-card-rich-header">
                      <span
                        className={`ingredient-detail-row-icon tone-${
                          presentation.tone === 'expired'
                            ? 'danger'
                            : presentation.tone === 'expiring'
                              ? 'warning'
                              : 'green'
                        }`}
                        aria-hidden="true"
                      >
                        {props.renderIcon('stocked')}
                      </span>
                      <div className="inventory-card-rich-titles">
                        <div className="inline-between">
                          <h3>
                            剩余{' '}
                            {formatNumericString(
                              convertQuantityToDefaultUnit(
                                ingredient,
                                getInventoryRemainingQuantity(item),
                                item.unit
                              ) ?? getInventoryRemainingQuantity(item)
                            )}
                            {' '}{ingredient.default_unit || item.unit}
                          </h3>
                          <Badge className={`badge-tone-${presentation.tone}`}>{presentation.label}</Badge>
                        </div>
                        <p className="subtle ingredient-detail-icon-line">
                          <span aria-hidden="true">{props.renderIcon('calendar')}</span>
                          {item.storage_location || '常温'} · 购于 {formatDate(item.purchase_date)}
                          {item.expiry_date ? ` · ${formatRelativeDays(item.expiry_date)}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="inventory-card-rich-body">
                      <p>
                        {getInventoryConsumedQuantity(item) > 0
                          ? `加入库存 ${formatNumericString(
                              convertQuantityToDefaultUnit(ingredient, item.quantity, item.unit) ?? item.quantity
                            )} ${ingredient.default_unit || item.unit}，已记录用量 ${formatNumericString(
                              convertQuantityToDefaultUnit(
                                ingredient,
                                getInventoryConsumedQuantity(item),
                                item.unit
                              ) ?? getInventoryConsumedQuantity(item)
                            )} ${ingredient.default_unit || item.unit}${
                              item.entered_quantity !== null &&
                              item.entered_quantity !== undefined &&
                              item.entered_unit &&
                              (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                                item.entered_unit !== item.unit)
                                ? ` · 加入时 ${formatNumericString(item.entered_quantity)} ${item.entered_unit}`
                                : ''
                            }${item.notes ? ` · ${item.notes}` : ''}`
                          : item.notes ||
                            `加入库存 ${formatNumericString(
                              convertQuantityToDefaultUnit(ingredient, item.quantity, item.unit) ?? item.quantity
                            )} ${ingredient.default_unit || item.unit}${
                              item.entered_quantity !== null &&
                              item.entered_quantity !== undefined &&
                              item.entered_unit &&
                              (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                                item.entered_unit !== item.unit)
                                ? ` · 加入时 ${formatNumericString(item.entered_quantity)} ${item.entered_unit}`
                                : ''
                            }`}
                      </p>
                    </div>

                    {isItemAvailable && (
                      <div className="inventory-card-rich-footer">
                        <button
                          type="button"
                          className="inventory-card-quick-consume-btn"
                          onClick={() => props.openConsumeOverlay(ingredient.id)}
                        >
                          ⚡️ 记录用量
                        </button>
                      </div>
                    )}
                  </article>
                );
              })
            ) : (
              <EmptyState
                title="还没有库存"
                description="加入库存后，就能记录保质期和日常用量。"
                action={
                  <button
                    className="solid-button"
                    type="button"
                    onClick={() => props.openInventoryOverlay(ingredient.id)}
                  >
                    + 加入库存
                  </button>
                }
              />
            )}
          </div>
        </section>

        {/* Right Column: Rules & Related Recipes */}
        <div className="ingredient-detail-right-column">
          <section className="card ingredient-detail-section">
            <SectionHeading title="补货默认规则" description="补充库存时自动带出的设置" />
            <div className="stack-list">
              <article className="ingredient-related-row">
                <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                  {props.renderIcon('calendar')}
                </span>
                <div>
                  <h3>默认保质期</h3>
                  <p className="subtle">{props.formatExpiryRuleLabel(ingredient)}</p>
                </div>
                <Badge>
                  {ingredient.default_expiry_mode === 'days'
                    ? '自动计算到期日'
                    : ingredient.default_expiry_mode === 'manual_date'
                      ? '手动填写到期日'
                      : '不设置到期提醒'}
                </Badge>
              </article>

              <article className="ingredient-related-row">
                <span className="ingredient-detail-row-icon tone-orange" aria-hidden="true">
                  {props.renderIcon('bell')}
                </span>
                <div>
                  <h3>低库存提醒</h3>
                  <p className="subtle">{props.formatLowStockRuleLabel(ingredient)}</p>
                </div>
                <Badge>
                  {ingredient.default_low_stock_threshold !== null &&
                  ingredient.default_low_stock_threshold !== undefined
                    ? '已开启提醒'
                    : '未开启'}
                </Badge>
              </article>

              <article className="ingredient-related-row">
                <span className="ingredient-detail-row-icon tone-green" aria-hidden="true">
                  {props.renderIcon('swap')}
                </span>
                <div>
                  <h3>单位与换算</h3>
                  <p className="subtle">
                    {ingredient.unit_conversions.length > 0
                      ? ingredient.unit_conversions
                          .map(
                            (item) =>
                              `1 ${item.unit} = ${formatNumericString(item.ratio_to_default)} ${ingredient.default_unit}`
                          )
                          .join(' · ')
                      : `默认单位为 ${ingredient.default_unit || '个'}，无需换算。`}
                  </p>
                </div>
                <Badge>
                  {ingredient.unit_conversions.length > 0
                    ? `${ingredient.unit_conversions.length} 个其他单位`
                    : '默认单位'}
                </Badge>
              </article>
            </div>
          </section>

          <section className="card ingredient-detail-section">
            <SectionHeading title="相关菜谱" description="使用这项食材的菜谱" />
            <div className="stack-list">
              {selectedIngredient.recipeReferences.length > 0 ? (
                selectedIngredient.recipeReferences.map((item) => {
                  const linkedRecipe = props.recipes.find((recipe) => recipe.id === item.id) ?? null;
                  const linkedImageUrl = resolveAssetUrl(linkedRecipe?.images[0]?.url);

                  return (
                    <article key={item.id} className="ingredient-related-row ingredient-related-recipe-row">
                      <MediaWithPlaceholder
                        className="ingredient-related-thumb"
                        src={linkedImageUrl}
                        alt={item.title}
                      />
                      <div className="ingredient-related-recipe-info">
                        <h3>{item.title}</h3>
                        <p className="subtle">这份菜谱使用了这项食材，做菜时会自动带出。</p>
                      </div>
                      <Badge className="badge-recipe">已使用</Badge>
                    </article>
                  );
                })
              ) : (
                <EmptyState
                  title="还没有相关菜谱"
                  description="新建菜谱时添加这项食材，就会显示在这里。"
                />
              )}
            </div>
          </section>
        </div>

        {/* Full-width Footer Metadata */}
        <section className="card ingredient-detail-section ingredient-detail-section-wide">
          <SectionHeading title="更多信息" description="添加时间、更新时间和存放位置" />
          <div className="ingredient-metadata">
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('calendar')}
              </span>
              <strong>添加时间：</strong>
              {formatDateTime(ingredient.created_at)}
            </p>
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('clock')}
              </span>
              <strong>最近更新：</strong>
              {formatDateTime(selectedIngredient.latestUpdatedAt || ingredient.updated_at)}
            </p>
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('inventory')}
              </span>
              <strong>存放位置：</strong>
              {selectedIngredient.storageLocations.join('、') || ingredient.default_storage || '常温'}
            </p>
          </div>
        </section>
      </div>
    </WorkspaceSubpageShell>
  );
}

import type { ReactNode } from 'react';
import type { Ingredient, Recipe } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import {
  convertQuantityToDefaultUnit,
  getInventoryConsumedQuantity,
  getInventoryRemainingQuantity,
} from '../../lib/ingredientUnits';
import {
  Avatar,
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

export function IngredientDetailView(props: IngredientDetailViewProps) {
  const { selectedIngredient } = props;

  return (
    <WorkspaceSubpageShell className="ingredients-workspace-subpage ingredients-detail-page">
      <header className="ingredient-detail-header">
        <div className="ingredient-detail-titleblock">
          <button className="workspace-back-link ingredient-detail-back" type="button" onClick={props.goBackToWorkspace}>
            ← {props.activePanelBackLabel}
          </button>
          <p className="eyebrow">食材详情</p>
          <h2>{selectedIngredient.ingredient.name}</h2>
          <p className="subtle">
            {selectedIngredient.ingredient.category || '未分类'} · 默认 {selectedIngredient.ingredient.default_unit || '个'} · 默认放在{' '}
            {selectedIngredient.ingredient.default_storage || '常温'}
          </p>
        </div>
        <div className="ingredient-detail-header-side">
          <Badge className="ingredient-detail-storage-badge">{props.detailStorageLabel}</Badge>
          <div className="ingredient-detail-primary-actions">
            <button
              className="solid-button"
              type="button"
              onClick={() => props.openInventoryOverlay(selectedIngredient.ingredient.id)}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('plus')}
              </span>
              补货
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => props.openConsumeOverlay(selectedIngredient.ingredient.id)}
              disabled={selectedIngredient.availableInventoryItems.length === 0}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('check')}
              </span>
              快速消费
            </button>
            <button
              className="tertiary-button"
              type="button"
              onClick={() =>
                props.openShoppingOverlay({
                  ingredient: selectedIngredient.ingredient,
                  reason: '库存偏低，准备补货',
                })
              }
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('shopping')}
              </span>
              加入购物清单
            </button>
          </div>
        </div>
      </header>

      <article className="ingredient-detail-hero">
        <div className="ingredient-detail-cover">
          {selectedIngredient.ingredient.image?.url ? (
            <img
              src={resolveAssetUrl(selectedIngredient.ingredient.image.url)}
              alt={selectedIngredient.ingredient.name}
            />
          ) : (
            <Avatar
              label={selectedIngredient.ingredient.name}
              seed={selectedIngredient.ingredient.name}
              large
            />
          )}
        </div>
        <div className="ingredient-detail-copy">
          <h3>{selectedIngredient.ingredient.notes || '适合搭配肉片和鸡蛋'}</h3>
          <div className="ingredient-detail-metric-grid" aria-label="食材摘要">
            {props.detailMetricItems.map((item) => (
              <div key={item.label} className={`ingredient-detail-metric tone-${item.tone}`}>
                <span className="ingredient-detail-metric-icon" aria-hidden="true">
                  {props.renderIcon(item.icon)}
                </span>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <div className="inline-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() => props.openEditView(selectedIngredient.ingredient)}
            >
              <span className="ingredient-detail-button-icon" aria-hidden="true">
                {props.renderIcon('edit')}
              </span>
              编辑资料卡
            </button>
          </div>
        </div>
      </article>

      <div className="ingredient-detail-grid">
        <section className="card ingredient-detail-section">
          <SectionHeading title="补货默认规则" description="以后登记新批次时，系统会先带出这些建议" />
          <div className="stack-list">
            <article className="ingredient-related-row">
              <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                {props.renderIcon('calendar')}
              </span>
              <div>
                <h3>默认保质期</h3>
                <p className="subtle">{props.formatExpiryRuleLabel(selectedIngredient.ingredient)}</p>
              </div>
              <Badge>
                {selectedIngredient.ingredient.default_expiry_mode === 'days'
                  ? '自动带日期'
                  : selectedIngredient.ingredient.default_expiry_mode === 'manual_date'
                    ? '填写包装日期'
                    : '不自动提醒'}
              </Badge>
            </article>
            <article className="ingredient-related-row">
              <span className="ingredient-detail-row-icon tone-orange" aria-hidden="true">
                {props.renderIcon('bell')}
              </span>
              <div>
                <h3>低库存提醒</h3>
                <p className="subtle">{props.formatLowStockRuleLabel(selectedIngredient.ingredient)}</p>
              </div>
              <Badge>
                {selectedIngredient.ingredient.default_low_stock_threshold !== null &&
                selectedIngredient.ingredient.default_low_stock_threshold !== undefined
                  ? '按食材总量判断'
                  : '暂未开启'}
              </Badge>
            </article>
            <article className="ingredient-related-row">
              <span className="ingredient-detail-row-icon tone-green" aria-hidden="true">
                {props.renderIcon('swap')}
              </span>
              <div>
                <h3>更多单位与换算</h3>
                <p className="subtle">
                  {selectedIngredient.ingredient.unit_conversions.length > 0
                    ? selectedIngredient.ingredient.unit_conversions
                        .map(
                          (item) =>
                            `1 ${item.unit} = ${formatNumericString(item.ratio_to_default)}${selectedIngredient.ingredient.default_unit}`
                        )
                        .join(' · ')
                    : '当前只使用主单位，不额外做换算。'}
                </p>
              </div>
              <Badge>
                {selectedIngredient.ingredient.unit_conversions.length > 0
                  ? `${selectedIngredient.ingredient.unit_conversions.length} 个副单位`
                  : '高级功能未启用'}
              </Badge>
            </article>
          </div>
        </section>

        <section className="card ingredient-detail-section">
          <SectionHeading title="当前提醒" description="优先处理临期和不足量食材" />
          <div className="stack-list">
            {selectedIngredient.alerts.length > 0 ? (
              <>
                {selectedIngredient.alerts.map((alert) => (
                  <article key={alert.id} className={`alert-card ${alert.tone}`}>
                    <span className="ingredient-detail-alert-icon" aria-hidden="true">
                      {props.renderIcon('exclamation')}
                    </span>
                    <div>
                      <h3>{alert.title}</h3>
                      <p>{alert.detail}</p>
                    </div>
                  </article>
                ))}
                <div className="ingredient-detail-tip">
                  <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                    {props.renderIcon('lightbulb')}
                  </span>
                  <strong>优先处理临期和不足量食材</strong>
                </div>
              </>
            ) : (
              <EmptyState
                title="状态很安稳"
                description="这份食材当前没有低库存或临期提醒。"
              />
            )}
          </div>
        </section>

        <section className="card ingredient-detail-section">
          <SectionHeading title="库存批次" description="按批次记录入库，并持续跟踪每批剩余量" />
          <div className="stack-list">
            {selectedIngredient.inventoryItems.length > 0 ? (
              selectedIngredient.inventoryItems.map((item) => (
                <article key={item.id} className={`inventory-card inventory-card-rich tone-${item.status}`}>
                  <span className="ingredient-detail-row-icon tone-green" aria-hidden="true">
                    {props.renderIcon('stocked')}
                  </span>
                  <div>
                    <div className="inline-between">
                      <h3>
                        剩余{' '}
                        {formatNumericString(
                          convertQuantityToDefaultUnit(
                            selectedIngredient.ingredient,
                            getInventoryRemainingQuantity(item),
                            item.unit
                          ) ?? getInventoryRemainingQuantity(item)
                        )}
                        {selectedIngredient.ingredient.default_unit || item.unit}
                      </h3>
                      <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                    </div>
                    <p className="subtle ingredient-detail-icon-line">
                      <span aria-hidden="true">{props.renderIcon('calendar')}</span>
                      {item.storage_location} · 购于 {formatDate(item.purchase_date)}
                      {item.expiry_date ? ` · ${formatRelativeDays(item.expiry_date)}` : ''}
                    </p>
                    <p>
                      {getInventoryConsumedQuantity(item) > 0
                        ? `原始入库 ${formatNumericString(
                            convertQuantityToDefaultUnit(selectedIngredient.ingredient, item.quantity, item.unit) ?? item.quantity
                          )}${selectedIngredient.ingredient.default_unit || item.unit}，已消费 ${formatNumericString(
                            convertQuantityToDefaultUnit(
                              selectedIngredient.ingredient,
                              getInventoryConsumedQuantity(item),
                              item.unit
                            ) ?? getInventoryConsumedQuantity(item)
                          )}${selectedIngredient.ingredient.default_unit || item.unit}${
                            item.entered_quantity !== null &&
                            item.entered_quantity !== undefined &&
                            item.entered_unit &&
                            (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                              item.entered_unit !== item.unit)
                              ? ` · 登记时 ${formatNumericString(item.entered_quantity)}${item.entered_unit}`
                              : ''
                          }${item.notes ? ` · ${item.notes}` : ''}`
                        : item.notes ||
                          `原始入库 ${formatNumericString(
                            convertQuantityToDefaultUnit(selectedIngredient.ingredient, item.quantity, item.unit) ?? item.quantity
                          )}${selectedIngredient.ingredient.default_unit || item.unit}${
                            item.entered_quantity !== null &&
                            item.entered_quantity !== undefined &&
                            item.entered_unit &&
                            (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                              item.entered_unit !== item.unit)
                              ? ` · 登记时 ${formatNumericString(item.entered_quantity)}${item.entered_unit}`
                              : ''
                          }`}
                    </p>
                  </div>
                </article>
              ))
            ) : (
              <EmptyState
                title="还没有库存批次"
                description="先登记第一批库存，这张资料卡就会更有用了。"
                action={
                  <button
                    className="solid-button"
                    type="button"
                    onClick={() => props.openInventoryOverlay(selectedIngredient.ingredient.id)}
                  >
                    立即登记
                  </button>
                }
              />
            )}
          </div>
        </section>

        <section className="card ingredient-detail-section">
          <SectionHeading title="关联菜谱" description="这份食材已经被哪些菜谱引用" />
          <div className="stack-list">
            {selectedIngredient.recipeReferences.length > 0 ? (
              selectedIngredient.recipeReferences.map((item) => {
                const linkedRecipe = props.recipes.find((recipe) => recipe.id === item.id) ?? null;
                const linkedImageUrl = resolveAssetUrl(linkedRecipe?.images[0]?.url);

                return (
                  <article key={item.id} className="ingredient-related-row">
                    {linkedImageUrl ? (
                      <img className="ingredient-related-thumb" src={linkedImageUrl} alt={item.title} />
                    ) : (
                      <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                        {props.renderIcon('link')}
                      </span>
                    )}
                    <div>
                      <h3>{item.title}</h3>
                      <p className="subtle">已在菜谱库中引用，可用于做饭推荐与食材串联。</p>
                    </div>
                    <Badge>已引用</Badge>
                  </article>
                );
              })
            ) : (
              <EmptyState
                title="还没有菜谱引用"
                description="后续在新建菜谱时选择这份食材，这里就会形成关联。"
              />
            )}
          </div>
        </section>

        <section className="card ingredient-detail-section ingredient-detail-section-wide">
          <SectionHeading title="资料信息" description="谁在什么时候补充了这张资料卡" />
          <div className="ingredient-metadata">
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('calendar')}
              </span>
              <strong>创建时间：</strong>
              {formatDateTime(selectedIngredient.ingredient.created_at)}
            </p>
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('clock')}
              </span>
              <strong>最近更新：</strong>
              {formatDateTime(selectedIngredient.latestUpdatedAt || selectedIngredient.ingredient.updated_at)}
            </p>
            <p>
              <span className="ingredient-metadata-icon" aria-hidden="true">
                {props.renderIcon('inventory')}
              </span>
              <strong>涉及位置：</strong>
              {selectedIngredient.storageLocations.join('、')}
            </p>
          </div>
        </section>
      </div>
    </WorkspaceSubpageShell>
  );
}

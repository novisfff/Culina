import type { CSSProperties, FormEvent } from 'react';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, Badge, FormActions, QuantityUnitField, WorkspaceModal } from '../ui-kit';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import type { IngredientSummaryViewModel } from './workspaceModel';
import type { ConsumeQuickPreset } from './consumeQuickHelpers';
import { formatNumericString } from './ingredientWorkspaceForms';

type ConsumeUnitOption = {
  unit: string;
  available: number;
};

type IngredientConsumeOverlayProps = {
  closeOverlay: () => void;
  consumeForm: { quantity: string; unit: string };
  selectedConsumeSummary: IngredientSummaryViewModel;
  selectedConsumePreview?: string;
  selectedConsumeMeta: string[];
  consumeUnitOptions: ConsumeUnitOption[];
  selectedConsumeUnit: ConsumeUnitOption | null;
  consumeAvailableQuantity: number;
  consumeStep: number;
  consumeSuggestedQuantity: number;
  consumeQuantityValue: number;
  consumeRemainingQuantity: number;
  consumeIsAllState: boolean;
  consumeCanSubmit: boolean;
  consumeRangeStyle: CSSProperties;
  consumeQuickValues: ConsumeQuickPreset[];
  consumeTotalRemainingLabel: string;
  updateConsumeUnit: (unit: string) => void;
  updateConsumeQuantity: (value: number) => void;
  updateConsumeQuantityInput: (value: string) => void;
  submitConsume: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isConsumingInventory?: boolean;
};

export function IngredientConsumeOverlay(props: IngredientConsumeOverlayProps) {
  const consumeFormId = 'ingredient-consume-overlay-form';
  const consumeTracksQuantity = tracksIngredientQuantity(props.selectedConsumeSummary.ingredient);
  const currentUnit = props.selectedConsumeUnit?.unit ?? props.consumeForm.unit;
  const consumeQuantityUnitOptions = [currentUnit, ...props.consumeUnitOptions.map((option) => option.unit)]
    .filter((unit, index, list) => unit && list.indexOf(unit) === index)
    .map((unit) => ({ value: unit, label: unit }));

  return (
    <WorkspaceModal
      title="快速消费"
      description="输入这次用掉的量，系统自动扣减库存。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="consume-quick-modal"
      onClose={props.closeOverlay}
      footerInfo={
        <div className="consume-quick-footer-summary">
          <span>本次将记录</span>
          <strong>
            {props.selectedConsumeUnit
              ? `${formatNumericString(props.consumeQuantityValue)}${props.selectedConsumeUnit.unit}`
              : '先选单位'}
          </strong>
          <p>
            {props.selectedConsumeUnit
              ? props.consumeIsAllState
                ? '提交后这一单位库存会接近清空。'
                : `提交后剩余 ${formatNumericString(props.consumeRemainingQuantity)}${props.selectedConsumeUnit.unit}。`
              : '系统会自动优先扣减更早到期批次。'}
          </p>
        </div>
      }
      footerActions={
        <FormActions
          className="consume-quick-actions"
          primaryLabel="确认消耗"
          primaryType="submit"
          primaryForm={consumeFormId}
          primaryDisabled={!props.consumeCanSubmit}
          isSubmitting={Boolean(props.isConsumingInventory)}
          secondaryLabel="取消"
          onSecondary={props.closeOverlay}
        />
      }
    >
      <form id={consumeFormId} className="consume-quick-form" onSubmit={(event) => void props.submitConsume(event)}>
        <div className="consume-quick-scroll">
          <section className="ingredients-restock-identity-card ingredients-consume-identity-card">
            <div className="ingredients-restock-identity-media">
              <MediaWithPlaceholder
                src={props.selectedConsumePreview}
                alt={props.selectedConsumeSummary.ingredient.name}
              />
            </div>
            <div className="ingredients-restock-identity-copy">
              <div className="ingredients-restock-identity-head">
                <div>
                  <h4>{props.selectedConsumeSummary.ingredient.name}</h4>
                  <p>{props.selectedConsumeMeta.join(' · ')}</p>
                </div>
                <div className="consume-quick-identity-badges">
                  <Badge>剩余 {props.consumeTotalRemainingLabel}</Badge>
                  {props.consumeIsAllState && <Badge className="consume-quick-state-badge">接近清空</Badge>}
                </div>
              </div>
              {props.consumeUnitOptions.length > 1 && (
                <div className="ingredients-consume-stock-strip consume-quick-stock-strip">
                  {props.consumeUnitOptions.map((item) => (
                    <span key={`${props.selectedConsumeSummary.ingredient.id}-${item.unit}`} className="ingredient-visual-pill">
                      {item.unit} · {formatNumericString(item.available)}
                      {item.unit}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section
            className={
              props.consumeIsAllState
                ? 'ingredients-restock-field-group ingredients-consume-amount-section is-all'
                : 'ingredients-restock-field-group ingredients-consume-amount-section'
            }
          >
            <div className="ingredients-restock-field-head">
              <span>本次用量</span>
            </div>
            <QuantityUnitField
              className="ingredients-consume-quantity-field"
              quantity={props.consumeForm.quantity}
              unit={currentUnit}
              unitOptions={consumeQuantityUnitOptions}
              quantityDisabled={!consumeTracksQuantity || !props.selectedConsumeUnit}
              quantityDisabledReason={
                !consumeTracksQuantity
                  ? '这个食材只记录是否还有，不按数量扣减。'
                  : !props.selectedConsumeUnit
                    ? '先选择可消费单位。'
                    : undefined
              }
              onQuantityChange={props.updateConsumeQuantityInput}
              onUnitChange={props.updateConsumeUnit}
            />
            <div
              className={
                props.consumeIsAllState
                  ? 'touch-field touch-range-field consume-quick-range-field is-all'
                  : 'touch-field touch-range-field consume-quick-range-field'
              }
            >
              <div className="touch-field-head consume-quick-range-head">
                <span>拖拉条</span>
              </div>
              <div className="touch-field-helper">
                {props.selectedConsumeUnit
                  ? `最多 ${formatNumericString(props.consumeAvailableQuantity)}${props.selectedConsumeUnit.unit}`
                  : '先选择单位'}
              </div>
              <div className="touch-range-main">
                <ActionButton
                  tone="secondary"
                  size="compact"
                  type="button"
                  className="touch-stepper-button"
                  aria-label="消费量减少"
                  disabled={!props.selectedConsumeUnit}
                  onClick={() => props.updateConsumeQuantity(props.consumeQuantityValue - props.consumeStep)}
                >
                  -
                </ActionButton>
                <input
                  className="touch-range-input"
                  type="range"
                  min={0}
                  max={props.consumeAvailableQuantity || props.consumeStep}
                  step={props.consumeStep}
                  value={props.consumeQuantityValue}
                  style={props.consumeRangeStyle}
                  disabled={!props.selectedConsumeUnit}
                  aria-valuetext={
                    props.selectedConsumeUnit
                      ? `${formatNumericString(props.consumeQuantityValue)}${props.selectedConsumeUnit.unit}`
                      : formatNumericString(props.consumeQuantityValue)
                  }
                  onChange={(event) => props.updateConsumeQuantity(Number(event.target.value))}
                />
                <ActionButton
                  tone="secondary"
                  size="compact"
                  type="button"
                  className="touch-stepper-button"
                  aria-label="消费量增加"
                  disabled={!props.selectedConsumeUnit}
                  onClick={() => props.updateConsumeQuantity(props.consumeQuantityValue + props.consumeStep)}
                >
                  +
                </ActionButton>
              </div>
            </div>
            {props.consumeQuickValues.length > 0 && (
              <div className="consume-quick-shortcut-row">
                {props.consumeQuickValues.map((item) => {
                  const isActive = item.isAll
                    ? props.consumeIsAllState
                    : Math.abs(props.consumeQuantityValue - item.value) < 0.001;
                  const className = ['consume-quick-shortcut', isActive ? 'active' : '', item.isAll ? 'is-all' : '']
                    .filter(Boolean)
                    .join(' ');

                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={className}
                      disabled={!props.selectedConsumeUnit}
                      onClick={() => props.updateConsumeQuantity(item.value)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>

      </form>
    </WorkspaceModal>
  );
}

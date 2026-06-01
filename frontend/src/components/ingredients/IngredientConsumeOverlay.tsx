import type { CSSProperties, FormEvent } from 'react';
import { ActionButton, Badge, WorkspaceModal } from '../ui-kit';
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
  selectedConsumePreview: string;
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
  return (
    <WorkspaceModal
      title="快速消费"
      description="记下这次实际用掉多少，系统会自动从更早到期的批次开始扣减。"
      closeLabel="×"
      closeAriaLabel="关闭"
      className="consume-quick-modal"
      onClose={props.closeOverlay}
    >
      <form className="consume-quick-form" onSubmit={(event) => void props.submitConsume(event)}>
        <div className="consume-quick-scroll">
          <section className="ingredients-restock-identity-card ingredients-consume-identity-card">
            <div className="ingredients-restock-identity-media">
              <img src={props.selectedConsumePreview} alt={props.selectedConsumeSummary.ingredient.name} />
            </div>
            <div className="ingredients-restock-identity-copy">
              <div className="ingredients-restock-identity-head">
                <div>
                  <h4>{props.selectedConsumeSummary.ingredient.name}</h4>
                  <p>{props.selectedConsumeMeta.join(' · ')}</p>
                </div>
                <div className="consume-quick-identity-badges">
                  <Badge>{props.selectedConsumeSummary.inventoryItems.length} 条批次</Badge>
                  {props.consumeIsAllState && <Badge className="consume-quick-state-badge">接近清空</Badge>}
                </div>
              </div>
              <div className="consume-quick-identity-summary">
                <article className="consume-quick-summary-card is-primary">
                  <span>当前总剩余</span>
                  <strong>{props.consumeTotalRemainingLabel}</strong>
                  <p>{props.selectedConsumeSummary.inventoryItems.length} 条批次会参与这次扣减</p>
                </article>
                <article className="consume-quick-summary-card">
                  <span>扣减方式</span>
                  <strong>优先更早到期</strong>
                  <p>系统会自动从更早到期的批次开始扣减。</p>
                </article>
              </div>
              <div className="ingredients-consume-stock-strip consume-quick-stock-strip">
                {props.consumeUnitOptions.map((item) => (
                  <span key={`${props.selectedConsumeSummary.ingredient.id}-${item.unit}`} className="ingredient-visual-pill">
                    可按 {item.unit} 记 {formatNumericString(item.available)}
                    {item.unit}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="ingredients-restock-field-group ingredients-consume-unit-section">
            <div className="ingredients-restock-field-head">
              <span>记录单位</span>
              <p className="subtle">
                {props.consumeUnitOptions.length > 1
                  ? '先选这次实际用掉的是哪种单位，切换后数量会自动对齐到该单位剩余量。'
                  : '直接按这个单位记录就行，系统会自动处理批次扣减。'}
              </p>
            </div>
            {props.consumeUnitOptions.length === 1 && props.selectedConsumeUnit ? (
              <div className="ingredients-consume-unit-single">
                <div className="ingredients-consume-unit-single-main">
                  <span>当前单位</span>
                  <strong>{props.selectedConsumeUnit.unit}</strong>
                </div>
                <div className="ingredients-consume-unit-single-meta">
                  <span>当前剩余</span>
                  <strong>
                    {formatNumericString(props.selectedConsumeUnit.available)}
                    {props.selectedConsumeUnit.unit}
                  </strong>
                </div>
              </div>
            ) : (
              <div className="ingredients-restock-choice-row ingredients-consume-unit-row">
                {props.consumeUnitOptions.map((item) => (
                  <button
                    key={`${props.selectedConsumeSummary.ingredient.id}-${item.unit}`}
                    type="button"
                    className={
                      props.selectedConsumeUnit?.unit === item.unit
                        ? 'ingredients-choice-chip ingredients-consume-unit-chip active'
                        : 'ingredients-choice-chip ingredients-consume-unit-chip'
                    }
                    onClick={() => props.updateConsumeUnit(item.unit)}
                  >
                    <span className="ingredients-consume-unit-chip-label">{item.unit}</span>
                    <small>
                      当前剩余 {formatNumericString(item.available)}
                      {item.unit}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section
            className={
              props.consumeIsAllState
                ? 'ingredients-restock-field-group ingredients-consume-amount-section is-all'
                : 'ingredients-restock-field-group ingredients-consume-amount-section'
            }
          >
            <div className="ingredients-restock-field-head">
              <span>消费量</span>
              <p className="subtle">拖动滑条快速操作，也可以点快捷值或直接输入来微调。</p>
            </div>
            <div className="consume-quick-live-row">
              <article className="consume-quick-live-card is-active">
                <span>本次消费</span>
                <strong>
                  {props.selectedConsumeUnit
                    ? `${formatNumericString(props.consumeQuantityValue)}${props.selectedConsumeUnit.unit}`
                    : '先选单位'}
                </strong>
                <p>滑动时会实时同步到提交结果。</p>
              </article>
              <article className={props.consumeIsAllState ? 'consume-quick-live-card is-warning' : 'consume-quick-live-card'}>
                <span>消费后剩余</span>
                <strong>
                  {props.selectedConsumeUnit
                    ? `${formatNumericString(props.consumeRemainingQuantity)}${props.selectedConsumeUnit.unit}`
                    : '先选单位'}
                </strong>
                <p>{props.consumeIsAllState ? '这次会把当前单位库存几乎用完。' : '保留量会随着拖动即时更新。'}</p>
              </article>
            </div>
            <div
              className={
                props.consumeIsAllState
                  ? 'touch-field touch-range-field consume-quick-range-field is-all'
                  : 'touch-field touch-range-field consume-quick-range-field'
              }
            >
              <div className="touch-field-head consume-quick-range-head">
                <span>拖拉条</span>
                <label className="consume-quick-range-editor-shell">
                  <input
                    className="consume-quick-range-editor-input"
                    type="number"
                    min={0}
                    max={props.consumeAvailableQuantity || undefined}
                    step={props.consumeStep}
                    inputMode="decimal"
                    aria-label="消费量输入"
                    placeholder={formatNumericString(props.consumeSuggestedQuantity)}
                    value={props.consumeForm.quantity}
                    disabled={!props.selectedConsumeUnit}
                    onChange={(event) => props.updateConsumeQuantityInput(event.target.value)}
                  />
                  <strong>{(props.selectedConsumeUnit?.unit ?? props.consumeForm.unit) || '单位'}</strong>
                </label>
              </div>
              <div className="touch-field-helper">
                {props.selectedConsumeUnit
                  ? `当前最多 ${formatNumericString(props.consumeAvailableQuantity)}${props.selectedConsumeUnit.unit}，拖动或直接改数字都会同步预估剩余量。`
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

        <div className="consume-quick-footer-bar">
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
          <div className="workspace-overlay-actions">
            <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
              取消
            </ActionButton>
            <ActionButton tone="primary" type="submit" disabled={props.isConsumingInventory || !props.consumeCanSubmit}>
              {props.isConsumingInventory ? '保存中...' : '记录这次消费'}
            </ActionButton>
          </div>
        </div>
      </form>
    </WorkspaceModal>
  );
}

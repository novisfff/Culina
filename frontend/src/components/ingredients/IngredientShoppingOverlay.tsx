import type { FormEvent } from 'react';
import type { Ingredient, IngredientUnitConversion } from '../../api/types';
import { ActionButton, Badge, TouchStepperField, WorkspaceModal } from '../ui-kit';
import { resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import { buildUnitPresetOptions, formatNumericString, type ShoppingDialogFormState } from './ingredientWorkspaceForms';

type IngredientShoppingOverlayProps = {
  closeOverlay: () => void;
  ingredients: Ingredient[];
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  selectedShoppingIngredient: Ingredient | null;
  selectedShoppingIngredientPreview: string;
  selectedShoppingIngredientMeta: string[];
  shoppingIngredientUnitOptions: IngredientUnitConversion[];
  shoppingQuantityValue: number;
  shoppingQuantityStep: number;
  shoppingQuantityQuickValues: number[];
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingShopping?: boolean;
};

export function IngredientShoppingOverlay(props: IngredientShoppingOverlayProps) {
  const shoppingUnitOptions = buildUnitPresetOptions(props.shoppingForm.unit || '个');

  return (
    <WorkspaceModal
      title="新增采购项"
      description="把这次要买的数量和原因快速记下来。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="workspace-modal-wide shopping-quick-modal"
      onClose={props.closeOverlay}
    >
      <form className="shopping-quick-form" onSubmit={(event) => void props.submitShopping(event)}>
        <div className="shopping-quick-scroll">
          {props.selectedShoppingIngredient ? (
            <section className="ingredients-restock-identity-card">
              <div className="ingredients-restock-identity-media">
                <img src={props.selectedShoppingIngredientPreview} alt={props.selectedShoppingIngredient.name} />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{props.selectedShoppingIngredient.name}</h4>
                    <p>{props.selectedShoppingIngredientMeta.join(' · ')}</p>
                  </div>
                  <Badge>档案食材</Badge>
                </div>
              </div>
            </section>
          ) : (
            <label className="shopping-quick-name-field">
              <span>名称</span>
              <input
                className="text-input"
                list="shopping-ingredient-options"
                placeholder="输入名称或直接选食材"
                value={props.shoppingForm.title}
                onChange={(event) => {
                  const nextTitle = event.target.value;
                  const matchedIngredient = props.ingredients.find((item) => item.name === nextTitle) ?? null;
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    title: nextTitle,
                    unit: matchedIngredient
                      ? resolvePreferredIngredientUnit(matchedIngredient, props.shoppingForm.unit) ||
                        matchedIngredient.default_unit
                      : props.shoppingForm.unit,
                  });
                }}
              />
              <datalist id="shopping-ingredient-options">
                {props.ingredients.map((ingredient) => (
                  <option key={ingredient.id} value={ingredient.name} />
                ))}
              </datalist>
            </label>
          )}

          <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
            <div className="ingredients-restock-quantity-row">
              <TouchStepperField
                label="数量"
                value={props.shoppingQuantityValue}
                min={props.shoppingQuantityStep}
                step={props.shoppingQuantityStep}
                quickValues={props.shoppingQuantityQuickValues}
                allowCustomInput
                customInputMode="inline"
                customInputLabel="直接输入"
                inputMin={props.shoppingQuantityStep}
                inputStep={props.shoppingQuantityStep}
                formatValue={(value) => formatNumericString(value)}
                helper="常见数量点一下就能完成。"
                onChange={(value) =>
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    quantity: formatNumericString(value),
                  })
                }
              />
              <section className="ingredients-restock-unit-card">
                <div className="ingredients-restock-unit-card-head">
                  <span>单位</span>
                  <strong>{props.shoppingForm.unit || props.selectedShoppingIngredient?.default_unit || '个'}</strong>
                </div>
                {props.selectedShoppingIngredient ? (
                  <>
                    <p className="subtle">默认先用主单位，常用副单位点一下就能切换。</p>
                    <div className="ingredients-restock-unit-chip-row">
                      {props.shoppingIngredientUnitOptions.map((option) => (
                        <button
                          key={`shopping-unit-${option.unit}`}
                          type="button"
                          className={
                            props.shoppingForm.unit === option.unit
                              ? 'ingredients-choice-chip ingredients-unit-chip active'
                              : 'ingredients-choice-chip ingredients-unit-chip'
                          }
                          onClick={() =>
                            props.setShoppingForm({
                              ...props.shoppingForm,
                              unit: option.unit,
                            })
                          }
                        >
                          {option.unit}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="subtle">默认值不对时再改。</p>
                    <details className="ingredients-restock-unit-editor">
                      <summary>修改单位</summary>
                      <input
                        className="text-input"
                        list="shopping-unit-options"
                        value={props.shoppingForm.unit}
                        onChange={(event) =>
                          props.setShoppingForm({ ...props.shoppingForm, unit: event.target.value })
                        }
                      />
                      <datalist id="shopping-unit-options">
                        {shoppingUnitOptions.map((unit) => (
                          <option key={unit} value={unit} />
                        ))}
                      </datalist>
                    </details>
                  </>
                )}
              </section>
            </div>
          </section>

          <section className="ingredients-restock-field-group">
            <div className="ingredients-restock-field-head">
              <span>原因</span>
              <p className="subtle">留一句自己回头能看懂的备注就行。</p>
            </div>
            <input
              className="text-input"
              placeholder="例如 备一份新的，替换临期库存"
              value={props.shoppingForm.reason}
              onChange={(event) =>
                props.setShoppingForm({ ...props.shoppingForm, reason: event.target.value })
              }
            />
          </section>
        </div>

        <div className="shopping-quick-footer-bar">
          <div className="workspace-overlay-actions">
            <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
              取消
            </ActionButton>
            <ActionButton tone="primary" type="submit" disabled={props.isCreatingShopping}>
              {props.isCreatingShopping ? '保存中...' : '加入清单'}
            </ActionButton>
          </div>
        </div>
      </form>
    </WorkspaceModal>
  );
}

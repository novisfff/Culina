import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Ingredient, IngredientUnitConversion } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, Badge, TouchStepperField, WorkspaceModal } from '../ui-kit';
import { resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { resolveMediaUrl } from '../../lib/assets';
import { buildUnitPresetOptions, formatNumericString, type ShoppingDialogFormState } from './ingredientWorkspaceForms';

type IngredientShoppingOverlayProps = {
  closeOverlay: () => void;
  ingredients: Ingredient[];
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  selectedShoppingIngredient: Ingredient | null;
  selectedShoppingIngredientPreview?: string;
  selectedShoppingIngredientMeta: string[];
  shoppingIngredientUnitOptions: IngredientUnitConversion[];
  shoppingQuantityValue: number;
  shoppingQuantityStep: number;
  shoppingQuantityQuickValues: number[];
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingShopping?: boolean;
};

type CustomSelectOption = {
  value: string;
  label: string;
};

function CustomSelect(props: {
  placeholder: string;
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = props.options.find((opt) => opt.value === props.value);
  const triggerLabel = selectedOption ? selectedOption.label : props.placeholder;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="custom-select-container" ref={containerRef} aria-expanded={isOpen}>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span>{triggerLabel}</span>
        <span className="custom-select-arrow" />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown">
          {props.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select-option ${props.value === option.value ? 'selected' : ''}`}
              onClick={() => {
                props.onChange(option.value);
                setIsOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomAutocomplete(props: {
  ingredients: Ingredient[];
  value: string;
  onChange: (value: string, matchedIngredient: Ingredient | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const query = props.value.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!query) return props.ingredients.slice(0, 10);
    return props.ingredients
      .filter((item) => item.name.toLowerCase().includes(query))
      .slice(0, 10);
  }, [props.ingredients, query]);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  return (
    <div className="custom-combobox-container" ref={containerRef}>
      <input
        className="text-input"
        placeholder="输入名称或直接选食材"
        value={props.value}
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          const nextVal = event.target.value;
          const matchedItem = props.ingredients.find((item) => item.name === nextVal) ?? null;
          props.onChange(nextVal, matchedItem);
        }}
      />
      <span className="custom-combobox-arrow" />
      {isOpen && matched.length > 0 && (
        <div className="custom-combobox-dropdown">
          {matched.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`custom-combobox-option ${props.value === item.name ? 'selected' : ''}`}
              onClick={() => {
                props.onChange(item.name, item);
                setIsOpen(false);
              }}
            >
              <div className="custom-combobox-option-avatar">
                <MediaWithPlaceholder
                  src={resolveMediaUrl(item.image, 'thumb')}
                  alt={item.name}
                />
              </div>
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function IngredientShoppingOverlay(props: IngredientShoppingOverlayProps) {
  const shoppingUnitOptions = buildUnitPresetOptions(props.shoppingForm.unit || '个');
  const tracksQuantity = tracksIngredientQuantity(props.selectedShoppingIngredient);
  const unitOptions = useMemo(() => {
    return shoppingUnitOptions.map((unit) => ({ value: unit, label: unit }));
  }, [shoppingUnitOptions]);

  return (
    <WorkspaceModal
      title="新增采购项"
      description="从已有食材里选择要买的东西，再记录数量和原因。"
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
                <MediaWithPlaceholder
                  src={props.selectedShoppingIngredientPreview}
                  alt={props.selectedShoppingIngredient.name}
                />
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
            <div className="shopping-quick-name-field">
              <span>名称</span>
              <CustomAutocomplete
                ingredients={props.ingredients}
                value={props.shoppingForm.title}
                onChange={(nextTitle, matchedIngredient) => {
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
              {props.shoppingForm.title.trim() && !props.selectedShoppingIngredient && (
                <p className="subtle">采购清单只能选择已有食材。没有这个食材时，请先创建食材档案。</p>
              )}
            </div>
          )}

          {tracksQuantity ? (
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
                    <div className="ingredients-restock-unit-editor-custom">
                      <CustomSelect
                        placeholder="选择单位"
                        value={props.shoppingForm.unit}
                        options={unitOptions}
                        onChange={(val) =>
                          props.setShoppingForm({ ...props.shoppingForm, unit: val })
                        }
                      />
                    </div>
                  </>
                )}
              </section>
            </div>
          </section>
          ) : (
            <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
              <div className="ingredients-create-rule-note ingredients-create-lowstock-note">
                <span>需要补充</span>
                <p>这类食材不要求精确采购数量，清单里会显示为需要补充。</p>
              </div>
            </section>
          )}

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

          <div className="shopping-quick-footer-bar">
            <div className="workspace-overlay-actions">
              <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                取消
              </ActionButton>
              <ActionButton tone="primary" type="submit" disabled={props.isCreatingShopping || !props.selectedShoppingIngredient}>
                {props.isCreatingShopping ? '保存中...' : '加入清单'}
              </ActionButton>
            </div>
          </div>
        </div>
      </form>
    </WorkspaceModal>
  );
}

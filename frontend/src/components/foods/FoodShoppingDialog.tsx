import { useState, type FormEvent } from 'react';
import type { Food, ShoppingListItem } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { resolveTouchStep } from '../ingredients/ingredientWorkspaceForms';
import { formatFoodStockQuantity } from './FoodWorkspaceHelpers';
import type { FoodShoppingDraft } from './FoodShoppingModel';

type FoodShoppingDialogProps = {
  food: Food;
  draft: FoodShoppingDraft;
  existingItem: ShoppingListItem | null;
  onDraftChange: (draft: FoodShoppingDraft) => void;
  onSubmit: () => void;
  onClose: () => void;
  busy?: boolean;
  errorMessage?: string | null;
};

function adjustQuantity(value: string, unit: string, direction: -1 | 1) {
  const step = resolveTouchStep(unit || '份');
  const current = Number(value);
  const next = Math.max(step, (Number.isFinite(current) ? current : step) + direction * step);
  return String(Number(next.toFixed(3)));
}

export function FoodShoppingDialog(props: FoodShoppingDialogProps) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const formId = 'food-shopping-dialog-form';
  const preview = resolveMediaUrl(props.food.images?.[0], 'thumb');
  const closeIfAllowed = () => {
    if (!props.busy) props.onClose();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSubmit();
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="food-shopping-overlay-root"
      closeOnBackdrop={!props.busy}
      busy={props.busy}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title="确认采购"
        description={props.existingItem ? '正在编辑已有采购项，数量表示确认后的最终总量。' : '确认后再加入采购清单。'}
        closeLabel="关闭"
        closeAriaLabel="关闭采购确认"
        className="food-shopping-modal"
        busy={props.busy}
        onClose={closeIfAllowed}
        footerActions={
          <FormActions
            primaryLabel={props.existingItem ? '确认更新' : '确认加入'}
            primaryType="submit"
            primaryForm={formId}
            isSubmitting={Boolean(props.busy)}
            submittingLabel="正在保存..."
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={formId} className="food-shopping-form" onSubmit={submit}>
          <section className="food-shopping-item">
            <div className="food-shopping-item-main">
              <div className="food-shopping-item-media">
                <MediaWithPlaceholder src={preview} alt={props.food.name} />
              </div>
              <div className="food-shopping-item-copy">
                <strong>{props.food.name}</strong>
                <span>成品速食 · 当前库存 {formatFoodStockQuantity(props.food)}</span>
              </div>
              <div className="food-shopping-quantity" aria-label="待买数量">
                <button
                  type="button"
                  aria-label="减少待买数量"
                  disabled={props.busy}
                  onClick={() => props.onDraftChange({
                    ...props.draft,
                    quantity: adjustQuantity(props.draft.quantity, props.draft.unit, -1),
                  })}
                >
                  -
                </button>
                <input
                  name="food-shopping-quantity"
                  inputMode="decimal"
                  aria-label="待买数量"
                  value={props.draft.quantity}
                  disabled={props.busy}
                  onChange={(event) => props.onDraftChange({ ...props.draft, quantity: event.target.value })}
                />
                <button
                  type="button"
                  aria-label="增加待买数量"
                  disabled={props.busy}
                  onClick={() => props.onDraftChange({
                    ...props.draft,
                    quantity: adjustQuantity(props.draft.quantity, props.draft.unit, 1),
                  })}
                >
                  +
                </button>
              </div>
            </div>

            <button
              className="food-shopping-detail-toggle"
              type="button"
              aria-expanded={detailsExpanded}
              disabled={props.busy}
              onClick={() => setDetailsExpanded((current) => !current)}
            >
              <span>单位：{props.draft.unit || '份'}</span>
              <span>{detailsExpanded ? '收起详情' : '展开详情'}</span>
            </button>

            {detailsExpanded ? (
              <div className="food-shopping-item-details">
                <label>
                  <span>单位</span>
                  <input
                    name="food-shopping-unit"
                    value={props.draft.unit}
                    disabled={props.busy}
                    onChange={(event) => props.onDraftChange({ ...props.draft, unit: event.target.value })}
                  />
                </label>
                <label>
                  <span>采购原因</span>
                  <input
                    name="food-shopping-reason"
                    value={props.draft.reason}
                    disabled={props.busy}
                    onChange={(event) => props.onDraftChange({ ...props.draft, reason: event.target.value })}
                  />
                </label>
              </div>
            ) : null}
          </section>
          {props.errorMessage ? <p className="food-shopping-error" role="alert">{props.errorMessage}</p> : null}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

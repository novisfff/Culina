import { ActionButton } from '../ui-kit';
import type { IngredientWorkspacePanel } from './workspaceModel';

type Props = {
  activePanel: IngredientWorkspacePanel;
  onCreateIngredient: () => void;
  onReconciliation: () => void;
  onInventoryOverlay: () => void;
  onShoppingIntake: () => void;
  onShoppingOverlay: () => void;
  onOperationHistory?: () => void;
};

/** Desktop action bar for the active Ingredient workspace panel. */
export function IngredientWorkspaceDesktopActions(props: Props) {
  return (
    <div className="ingredients-actions">
      {props.activePanel === 'catalog' && (
        <ActionButton tone="primary" type="button" onClick={props.onCreateIngredient}>
          新增食材
        </ActionButton>
      )}
      {props.activePanel === 'inventory' && (
        <>
          <ActionButton tone="primary" type="button" onClick={props.onReconciliation}>
            快速盘点
          </ActionButton>
          <ActionButton tone="secondary" type="button" onClick={props.onInventoryOverlay}>
            快速加入库存
          </ActionButton>
          {props.onOperationHistory ? (
            <ActionButton tone="tertiary" type="button" onClick={props.onOperationHistory}>
              变更记录
            </ActionButton>
          ) : null}
        </>
      )}
      {props.activePanel === 'shopping' && (
        <>
          <ActionButton tone="primary" type="button" onClick={props.onShoppingIntake}>
            记录本次购买
          </ActionButton>
          <ActionButton tone="secondary" type="button" onClick={props.onShoppingOverlay}>
            新增采购内容
          </ActionButton>
          {props.onOperationHistory ? (
            <ActionButton tone="tertiary" type="button" onClick={props.onOperationHistory}>
              变更记录
            </ActionButton>
          ) : null}
        </>
      )}
    </div>
  );
}
